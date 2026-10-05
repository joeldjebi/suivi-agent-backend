import { Injectable, Logger } from '@nestjs/common';
import { PayrollService } from '../payroll/payroll.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DayEndReason, Feature, ZoneRequestStatus } from '@suivi/shared';
import { In } from 'typeorm';
import { DbService } from '../common/db.service';
import { AlertsService } from '../common/alerts.service';
import { ReportsService } from '../reports/reports.service';
import { ZoneExitsService } from '../common/zone-exits.service';
import { workDate } from '../common/time.util';
import { TenantSettings, ZoneRequest } from '../entities';
import { DaysService } from '../days/days.service';
import { MissionsService } from '../missions/missions.service';
import { PositionsService } from '../positions/positions.service';
import { ZoneRequestsService } from '../zone-requests/zone-requests.service';

/**
 * Tâches planifiées. Chaque structure est traitée dans sa propre transaction, protégée
 * par un verrou consultatif : plusieurs instances de l'API ne la traitent jamais en double.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly zoneRequests: ZoneRequestsService,
    private readonly days: DaysService,
    private readonly missions: MissionsService,
    private readonly positions: PositionsService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly payrollService: PayrollService,
    private readonly zoneExits: ZoneExitsService,
    private readonly alerts: AlertsService,
    private readonly reports: ReportsService,
  ) {}

  /** Toutes les minutes : demandes en attente puis remise à zéro quotidienne. */
  @Cron(CronExpression.EVERY_MINUTE)
  async everyMinute() {
    if (this.running) return;
    this.running = true;
    try {
      await this.forEachTenant('minute', async (settings) => {
        await this.zoneRequests.processPending(settings);
        // Remise à zéro d'abord : elle referme les retards de la veille, pas ceux du jour.
        await this.dailyReset(settings);
        // Sorties de zone qui durent sans nouvelle position : le chef est prévenu quand même.
        await this.zoneExits.alertOverdue(settings.zoneExitAlertMinutes);
        await this.alerts.scan(settings);
        // Bilan de fin de journée aux responsables, à l'heure réglée (une fois par jour).
        await this.reports.sendDailyReports(settings);
      });
    } finally {
      this.running = false;
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async overdueMissions() {
    await this.forEachTenant('missions', () =>
      this.missions.failOverdue().then(() => undefined),
    );
  }

  /** Abonnements : fin d'essai, facture du mois écoulé, impayés (idempotent). */
  @Cron(CronExpression.EVERY_HOUR)
  async subscriptions(now = new Date()) {
    await this.forEachTenant('subscriptions', (settings) =>
      this.subscriptionsService.daily(settings.tenantId, now),
    );
  }

  /** Rémunération (formule Entreprise) : paie de la période écoulée préparée en brouillon. */
  @Cron(CronExpression.EVERY_HOUR)
  async payroll() {
    await this.forEachTenant('payroll', async (settings) => {
      const { features } = await this.subscriptionsService.summary(
        settings.tenantId,
      );
      if (features.includes(Feature.Payroll))
        await this.payrollService.prepareDraft();
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgePositions() {
    await this.forEachTenant('purge', async (settings) => {
      const deleted = await this.positions.purge(
        settings.positionRetentionDays,
      );
      if (deleted)
        this.logger.log(
          `Structure ${settings.tenantId} : ${deleted} positions purgées`,
        );
    });
  }

  /**
   * RG-22 : à l'heure définie, toutes les places sont libérées et, si la structure l'a choisi,
   * les journées encore ouvertes sont terminées. Rattrape une remise manquée après un arrêt.
   */
  async dailyReset(settings: TenantSettings, now = new Date()) {
    const today = workDate(now, settings.timezone, settings.dailyResetTime);
    const [{ last }] = await this.db.manager.query<{ last: string | null }[]>(
      `SELECT to_char(last_reset_date, 'YYYY-MM-DD') AS last FROM tenant_settings WHERE tenant_id = $1`,
      [settings.tenantId],
    );
    if (last === today) return;

    await this.alerts.resolveLateStarts(now);
    if (settings.autoEndDayAtReset) {
      for (const day of await this.days.openDays()) {
        await this.days.endDay(day, DayEndReason.AutoReset);
      }
    }
    await this.db.manager.update(
      ZoneRequest,
      { status: ZoneRequestStatus.Approved },
      {
        status: ZoneRequestStatus.Released,
        releasedAt: now,
        releaseReason: 'daily_reset',
      },
    );
    await this.db.manager.update(
      ZoneRequest,
      { status: In([ZoneRequestStatus.Pending]) },
      {
        status: ZoneRequestStatus.Cancelled,
        releasedAt: now,
        releaseReason: 'daily_reset',
      },
    );
    await this.db.manager.query(
      `UPDATE tenant_settings SET last_reset_date = $2 WHERE tenant_id = $1`,
      [settings.tenantId, today],
    );
    this.logger.log(
      `Structure ${settings.tenantId} : remise à zéro du ${today}`,
    );
  }

  private async forEachTenant(
    job: string,
    fn: (settings: TenantSettings) => Promise<void>,
  ) {
    const tenantIds = await this.db.runAsSystem(async () =>
      (
        await this.db.manager.find(TenantSettings, {
          select: { tenantId: true },
        })
      ).map((s) => s.tenantId),
    );
    for (const tenantId of tenantIds) {
      try {
        await this.db.runAsTenant(tenantId, async () => {
          const [{ locked }] = await this.db.manager.query<
            { locked: boolean }[]
          >(`SELECT pg_try_advisory_xact_lock(hashtext($1 || $2)) AS locked`, [
            job,
            tenantId,
          ]);
          if (!locked) return;
          const settings = await this.db.manager.findOneByOrFail(
            TenantSettings,
            { tenantId },
          );
          await fn(settings);
        });
      } catch (error) {
        this.logger.error(
          `Tâche ${job} en échec pour la structure ${tenantId}`,
          error as Error,
        );
      }
    }
  }
}
