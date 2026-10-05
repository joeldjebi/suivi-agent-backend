import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AdjustmentStatus,
  PayPeriod,
  PayRunStatus,
  Role,
  type PayGridComponents,
  type PayGridTargets,
} from '@suivi/shared';
import { In, IsNull } from 'typeorm';
import type { AuthUser } from '../common/auth-user';
import { AccessService } from '../common/access.service';
import {
  BusinessException,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../common/business.exception';
import { DbService } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { workDate } from '../common/time.util';
import {
  PayAdjustment,
  PayGrid,
  PayLine,
  PayRun,
  PaySettings,
  PlatformSettings,
} from '../entities';
import { PayrollCalculator, type ComputedLine } from './payroll.calculator';
import type {
  AdjustmentDto,
  MarkPaidDto,
  PayGridDto,
  PaySettingsDto,
} from './payroll.dto';
import { periodFor, periodLabel, previousPeriod, type Period } from './period';

const UUID = /^[0-9a-f-]{36}$/i;
const money = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100_000_000;

/** Vérifie une grille envoyée par le web (structure JSON libre). */
function checkGrid(dto: PayGridDto): {
  components: PayGridComponents;
  targets: PayGridTargets;
} {
  const c = dto.components as PayGridComponents;
  const errors: string[] = [];
  const optMoney = (v: unknown, label: string) => {
    if (v !== undefined && v !== null && !money(v)) errors.push(label);
  };
  optMoney(c.fixed, 'fixe');
  optMoney(c.cap, 'plafond');
  if (c.perDay) {
    optMoney(c.perDay.amount, 'montant par journée');
    if (
      c.perDay.minHours !== undefined &&
      c.perDay.minHours !== null &&
      !(c.perDay.minHours >= 0 && c.perDay.minHours <= 24)
    )
      errors.push('heures minimum');
  }
  if (c.perForm) {
    optMoney(c.perForm.amount, 'montant par formulaire');
    for (const [k, v] of Object.entries(c.perForm.byType ?? {})) {
      if (!UUID.test(k)) errors.push('type de mission');
      optMoney(v, 'montant par type');
    }
  }
  if (
    c.commission &&
    !(c.commission.percent >= 0 && c.commission.percent <= 100)
  )
    errors.push('commission');
  for (const t of c.objectiveBonus ?? []) {
    if (!(t.thresholdPercent > 0 && t.thresholdPercent <= 1000))
      errors.push('palier d’objectif');
    optMoney(t.amount, 'prime d’objectif');
  }
  optMoney(c.teamBonus?.perTeamDay, 'prime par journée d’équipe');
  optMoney(c.teamBonus?.perTeamForm, 'prime par formulaire d’équipe');
  optMoney(c.deductions?.perAutoClosedDay, 'retenue journée non clôturée');
  optMoney(c.deductions?.perRejectedForm, 'retenue formulaire rejeté');
  optMoney(c.deductions?.perMockedDay, 'retenue position simulée');

  const t = dto.targets as PayGridTargets;
  if (t.roles?.some((r) => r !== 'agent' && r !== 'team_lead'))
    errors.push('rôle');
  if (
    [...(t.groupIds ?? []), ...(t.userIds ?? [])].some((id) => !UUID.test(id))
  )
    errors.push('groupe ou agent');
  if (errors.length)
    throw badRequest(
      'INVALID_PAY_GRID',
      `Grille invalide : ${[...new Set(errors)].join(', ')}`,
    );
  return { components: c, targets: t };
}

/**
 * Rémunération (formule Entreprise) : calcul automatique par période, revue avec
 * ajustements (le chef propose, l'administrateur décide), validation, puis marquage
 * « payé » après un paiement fait hors de la plateforme.
 */
@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly calculator: PayrollCalculator,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- réglages

  async settings(): Promise<PaySettings> {
    const m = this.db.manager;
    const tenantId = this.db.tenantId;
    const found = await m.findOneBy(PaySettings, { tenantId });
    if (found) return found;
    await m.insert(PaySettings, { tenantId, period: PayPeriod.Monthly });
    return m.findOneByOrFail(PaySettings, { tenantId });
  }

  async updateSettings(dto: PaySettingsDto) {
    await this.settings();
    await this.db.manager.update(
      PaySettings,
      { tenantId: this.db.tenantId },
      { period: dto.period },
    );
    return this.settings();
  }

  private async currency(): Promise<string> {
    return (
      (await this.db.manager.findOneBy(PlatformSettings, { id: 1 }))
        ?.currency ?? 'XOF'
    );
  }

  private async today(): Promise<string> {
    const s = await this.access.settings();
    return workDate(new Date(), s.timezone, s.dailyResetTime);
  }

  // ---------------------------------------------------------------- grilles

  grids(): Promise<PayGrid[]> {
    return this.db.manager.find(PayGrid, { order: { name: 'ASC' } });
  }

  async createGrid(dto: PayGridDto) {
    const { components, targets } = checkGrid(dto);
    const saved = await this.db.manager.save(PayGrid, {
      tenantId: this.db.tenantId,
      name: dto.name.trim(),
      components,
      targets,
      isActive: dto.isActive ?? true,
    });
    return this.db.manager.findOneByOrFail(PayGrid, { id: saved.id });
  }

  async updateGrid(id: string, dto: PayGridDto) {
    const m = this.db.manager;
    if (!(await m.findOneBy(PayGrid, { id }))) throw notFound('Grille');
    const { components, targets } = checkGrid(dto);
    await m.update(
      PayGrid,
      { id },
      {
        name: dto.name.trim(),
        components,
        targets,
        ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
      },
    );
    return m.findOneByOrFail(PayGrid, { id });
  }

  async deleteGrid(id: string) {
    const result = await this.db.manager.delete(PayGrid, { id });
    if (!result.affected) throw notFound('Grille');
  }

  // ---------------------------------------------------------------- estimation

  /** Personnes qu'un utilisateur peut voir : tout (admin), son équipe et lui (chef), lui (agent). */
  private async scope(user: AuthUser): Promise<string[] | null> {
    if (user.role === Role.Admin) return null;
    if (user.role === Role.Agent) return [user.id];
    return [...((await this.access.agentScope(user)) ?? []), user.id];
  }

  private async computeFor(period: Period, onlyUserIds: string[] | null) {
    const s = await this.access.settings();
    return this.calculator.compute(
      period,
      s.timezone,
      await this.grids(),
      onlyUserIds,
    );
  }

  private presentLine(l: ComputedLine) {
    return {
      user: {
        id: l.payee.id,
        firstName: l.payee.firstName,
        lastName: l.payee.lastName,
        role: l.payee.role,
        phone: l.payee.phone,
      },
      gridId: l.grid?.id ?? null,
      gridName: l.grid?.name ?? null,
      items: l.items,
      gross: l.gross,
    };
  }

  /** Estimation de la période en cours, recalculée à chaque appel. */
  async current(user: AuthUser) {
    const { period: kind } = await this.settings();
    const period = periodFor(kind, await this.today());
    const lines = await this.computeFor(period, await this.scope(user));
    return {
      period: kind,
      ...period,
      label: periodLabel(kind, period),
      currency: await this.currency(),
      lines: lines.map((l) => this.presentLine(l)),
      total: lines.reduce((s, l) => s + l.gross, 0),
    };
  }

  // ---------------------------------------------------------------- paies

  /** Paies ; pour un chef d'équipe, les chiffres ne portent que sur son équipe. */
  async runs(user: AuthUser) {
    const scope = await this.scope(user);
    const runs = await this.db.manager.query<
      (PayRun & {
        lines: number;
        total: number;
        paidLines: number;
        pending: number;
      })[]
    >(
      `SELECT r.id, r.period, to_char(r.period_start, 'YYYY-MM-DD') AS "periodStart",
              to_char(r.period_end, 'YYYY-MM-DD') AS "periodEnd", r.status,
              r.computed_at AS "computedAt", r.validated_at AS "validatedAt", r.paid_at AS "paidAt",
              (SELECT count(*)::int FROM pay_lines l WHERE l.run_id = r.id AND l.total > 0
                 AND ($1::uuid[] IS NULL OR l.user_id = ANY($1::uuid[]))) AS lines,
              (SELECT coalesce(sum(l.total), 0)::int FROM pay_lines l WHERE l.run_id = r.id
                 AND ($1::uuid[] IS NULL OR l.user_id = ANY($1::uuid[]))) AS total,
              (SELECT count(*)::int FROM pay_lines l WHERE l.run_id = r.id AND l.paid_at IS NOT NULL
                 AND ($1::uuid[] IS NULL OR l.user_id = ANY($1::uuid[]))) AS "paidLines",
              (SELECT count(*)::int FROM pay_adjustments a WHERE a.run_id = r.id AND a.status = 'proposed'
                 AND ($1::uuid[] IS NULL OR a.user_id = ANY($1::uuid[]))) AS pending
       FROM pay_runs r ORDER BY r.period_start DESC`,
      [scope],
    );
    return runs.map((r) => ({
      ...r,
      label: periodLabel(r.period, { start: r.periodStart, end: r.periodEnd }),
    }));
  }

  private async runOrFail(id: string): Promise<PayRun> {
    const run = await this.db.manager.findOneBy(PayRun, { id });
    if (!run) throw notFound('Paie');
    return run;
  }

  async run(user: AuthUser, id: string) {
    const m = this.db.manager;
    const run = await this.runOrFail(id);
    const scope = await this.scope(user);
    const lines = await m.query<
      (PayLine & {
        firstName: string;
        lastName: string;
        role: string;
        phone: string | null;
        groupName: string | null;
      })[]
    >(
      `SELECT l.id, l.user_id AS "userId", l.grid_id AS "gridId", l.grid_name AS "gridName", l.items,
              l.gross, l.adjustments, l.total, l.paid_at AS "paidAt", l.payment_reference AS "paymentReference",
              u.first_name AS "firstName", u.last_name AS "lastName", u.role, u.phone, g.name AS "groupName"
       FROM pay_lines l JOIN users u ON u.id = l.user_id LEFT JOIN groups g ON g.id = u.group_id
       WHERE l.run_id = $1 AND ($2::uuid[] IS NULL OR l.user_id = ANY($2::uuid[]))
       ORDER BY u.last_name, u.first_name`,
      [id, scope],
    );
    const adjustments = await m.query<
      (PayAdjustment & { proposedBy: string | null })[]
    >(
      `SELECT a.id, a.user_id AS "userId", a.amount, a.reason, a.status, a.created_at AS "createdAt",
              a.decided_at AS "decidedAt",
              (SELECT first_name || ' ' || last_name FROM users WHERE id = a.proposed_by_id) AS "proposedBy"
       FROM pay_adjustments a
       WHERE a.run_id = $1 AND ($2::uuid[] IS NULL OR a.user_id = ANY($2::uuid[]))
       ORDER BY a.created_at`,
      [id, scope],
    );
    return {
      ...run,
      label: periodLabel(run.period, {
        start: run.periodStart,
        end: run.periodEnd,
      }),
      currency: await this.currency(),
      lines,
      adjustments,
    };
  }

  /** Paie d'une période terminée (la précédente par défaut) : créée ou recalculée tant qu'elle est en brouillon. */
  async createRun(date?: string) {
    const { period: kind } = await this.settings();
    const today = await this.today();
    const period = date ? periodFor(kind, date) : previousPeriod(kind, today);
    if (period.end >= today)
      throw conflict(
        'PERIOD_NOT_OVER',
        'Cette période n’est pas terminée : son estimation se met à jour en direct.',
      );
    const m = this.db.manager;
    let run = await m.findOneBy(PayRun, {
      periodStart: period.start,
      periodEnd: period.end,
    });
    if (!run) {
      const saved = await m.save(PayRun, {
        tenantId: this.db.tenantId,
        period: kind,
        periodStart: period.start,
        periodEnd: period.end,
        status: PayRunStatus.Draft,
        computedAt: new Date(),
      });
      run = await m.findOneByOrFail(PayRun, { id: saved.id });
    }
    await this.recompute(run);
    return run;
  }

  async recalculate(id: string) {
    const run = await this.runOrFail(id);
    await this.recompute(run);
    return this.runOrFail(id);
  }

  /** Recalcul des lignes d'une paie en brouillon ; les ajustements sont conservés. */
  private async recompute(run: PayRun) {
    if (run.status !== PayRunStatus.Draft)
      throw conflict(
        'RUN_LOCKED',
        'Cette paie est validée : elle ne peut plus être recalculée.',
      );
    const m = this.db.manager;
    const computed = await this.computeFor(
      { start: run.periodStart, end: run.periodEnd },
      null,
    );
    await m.delete(PayLine, { runId: run.id });
    if (computed.length) {
      await m.insert(
        PayLine,
        computed.map((l) => ({
          tenantId: this.db.tenantId,
          runId: run.id,
          userId: l.payee.id,
          gridId: l.grid?.id ?? null,
          gridName: l.grid?.name ?? null,
          items: l.items,
          gross: l.gross,
          adjustments: 0,
          total: l.gross,
        })),
      );
    }
    await m.update(PayRun, { id: run.id }, { computedAt: new Date() });
    await this.applyAdjustments(run.id);
  }

  /** Report des ajustements approuvés sur les lignes (total jamais négatif). */
  private async applyAdjustments(runId: string) {
    await this.db.manager.query(
      `WITH a AS (
         SELECT user_id, sum(amount)::int AS sum FROM pay_adjustments
         WHERE run_id = $1 AND status = 'approved' GROUP BY user_id)
       UPDATE pay_lines l SET
         adjustments = coalesce((SELECT sum FROM a WHERE a.user_id = l.user_id), 0),
         total = greatest(0, l.gross + coalesce((SELECT sum FROM a WHERE a.user_id = l.user_id), 0))
       WHERE l.run_id = $1`,
      [runId],
    );
  }

  async validate(user: AuthUser, id: string) {
    const m = this.db.manager;
    const run = await this.runOrFail(id);
    if (run.status !== PayRunStatus.Draft)
      throw conflict('RUN_LOCKED', 'Cette paie est déjà validée.');
    const pending = await m.countBy(PayAdjustment, {
      runId: id,
      status: AdjustmentStatus.Proposed,
    });
    if (pending)
      throw new BusinessException(
        HttpStatus.CONFLICT,
        'PENDING_ADJUSTMENTS',
        `${pending} ajustement(s) proposé(s) par les chefs d’équipe attendent votre décision.`,
        { pending },
      );
    await m.update(
      PayRun,
      { id },
      {
        status: PayRunStatus.Validated,
        validatedAt: new Date(),
        validatedById: user.id,
      },
    );
    const currency = await this.currency();
    const label = periodLabel(run.period, {
      start: run.periodStart,
      end: run.periodEnd,
    });
    const lines = await m.find(PayLine, { where: { runId: id } });
    for (const line of lines.filter((l) => l.total > 0)) {
      await this.notifications.notify([line.userId], {
        type: 'pay.validated',
        title: 'Vos gains sont validés',
        body: `${label} : ${line.total.toLocaleString('fr-FR')} ${currency}`,
        data: { runId: id },
      });
    }
    return this.runOrFail(id);
  }

  /** Paiement fait hors de la plateforme : on enregistre qui a été payé, et la référence. */
  async markPaid(id: string, dto: MarkPaidDto) {
    const m = this.db.manager;
    const run = await this.runOrFail(id);
    if (run.status === PayRunStatus.Draft)
      throw conflict(
        'RUN_NOT_VALIDATED',
        'Validez la paie avant de la marquer payée.',
      );
    const now = new Date();
    const where = {
      runId: id,
      paidAt: IsNull(),
      ...(dto.userIds?.length ? { userId: In(dto.userIds) } : {}),
    };
    const paid = await m.find(PayLine, { where });
    await m.update(PayLine, where, {
      paidAt: now,
      paymentReference: dto.reference?.trim() || null,
    });
    const remaining = await m.countBy(PayLine, { runId: id, paidAt: IsNull() });
    if (remaining === 0)
      await m.update(
        PayRun,
        { id },
        { status: PayRunStatus.Paid, paidAt: now },
      );
    const currency = await this.currency();
    for (const line of paid.filter((l) => l.total > 0)) {
      await this.notifications.notify([line.userId], {
        type: 'pay.paid',
        title: 'Paiement effectué',
        body: `${line.total.toLocaleString('fr-FR')} ${currency} vous ont été versés.`,
        data: { runId: id },
      });
    }
    return { paid: paid.length, remaining };
  }

  // ---------------------------------------------------------------- ajustements

  /** L'administrateur ajuste directement ; le chef propose pour ses agents. */
  async addAdjustment(user: AuthUser, runId: string, dto: AdjustmentDto) {
    const m = this.db.manager;
    const run = await this.runOrFail(runId);
    if (run.status !== PayRunStatus.Draft)
      throw conflict(
        'RUN_LOCKED',
        'Cette paie est validée : elle ne peut plus être ajustée.',
      );
    if (dto.amount === 0)
      throw badRequest('INVALID_AMOUNT', 'Le montant ne peut pas être nul');
    if (user.role === Role.TeamLead) {
      const scope = (await this.access.agentScope(user)) ?? [];
      if (!scope.includes(dto.userId))
        throw forbidden("Cet agent n'est pas dans votre équipe");
    }
    if (!(await m.findOneBy(PayLine, { runId, userId: dto.userId })))
      throw notFound('Ligne de paie');
    const admin = user.role === Role.Admin;
    const saved = await m.save(PayAdjustment, {
      tenantId: this.db.tenantId,
      runId,
      userId: dto.userId,
      amount: dto.amount,
      reason: dto.reason.trim(),
      status: admin ? AdjustmentStatus.Approved : AdjustmentStatus.Proposed,
      proposedById: user.id,
      decidedById: admin ? user.id : null,
      decidedAt: admin ? new Date() : null,
    });
    if (admin) await this.applyAdjustments(runId);
    else
      await this.notifications.notify(await this.access.adminIds(), {
        type: 'pay.adjustment_proposed',
        title: 'Ajustement de paie proposé',
        body: `${dto.amount > 0 ? '+' : ''}${dto.amount.toLocaleString('fr-FR')} : ${dto.reason.trim()}`,
        data: { runId, adjustmentId: saved.id },
      });
    return m.findOneByOrFail(PayAdjustment, { id: saved.id });
  }

  async decide(user: AuthUser, adjustmentId: string, approve: boolean) {
    const m = this.db.manager;
    const adj = await m.findOneBy(PayAdjustment, { id: adjustmentId });
    if (!adj) throw notFound('Ajustement');
    const run = await this.runOrFail(adj.runId);
    if (run.status !== PayRunStatus.Draft)
      throw conflict('RUN_LOCKED', 'Cette paie est validée.');
    if (adj.status !== AdjustmentStatus.Proposed)
      throw conflict('ALREADY_DECIDED', 'Cet ajustement a déjà été traité.');
    await m.update(
      PayAdjustment,
      { id: adjustmentId },
      {
        status: approve ? AdjustmentStatus.Approved : AdjustmentStatus.Rejected,
        decidedById: user.id,
        decidedAt: new Date(),
      },
    );
    await this.applyAdjustments(adj.runId);
    return m.findOneByOrFail(PayAdjustment, { id: adjustmentId });
  }

  async removeAdjustment(adjustmentId: string) {
    const m = this.db.manager;
    const adj = await m.findOneBy(PayAdjustment, { id: adjustmentId });
    if (!adj) throw notFound('Ajustement');
    const run = await this.runOrFail(adj.runId);
    if (run.status !== PayRunStatus.Draft)
      throw conflict('RUN_LOCKED', 'Cette paie est validée.');
    await m.delete(PayAdjustment, { id: adjustmentId });
    await this.applyAdjustments(adj.runId);
  }

  // ---------------------------------------------------------------- mes gains

  /** Agent ou chef : estimation en direct et historique des paies validées. */
  async mine(user: AuthUser) {
    const current = await this.current({ ...user, role: Role.Agent });
    const history = await this.db.manager.query<
      {
        runId: string;
        period: PayPeriod;
        periodStart: string;
        periodEnd: string;
        items: unknown;
        gross: number;
        adjustments: number;
        total: number;
        status: PayRunStatus;
        paidAt: Date | null;
        paymentReference: string | null;
      }[]
    >(
      `SELECT r.id AS "runId", r.period, to_char(r.period_start, 'YYYY-MM-DD') AS "periodStart",
              to_char(r.period_end, 'YYYY-MM-DD') AS "periodEnd", l.items, l.gross, l.adjustments, l.total,
              r.status, l.paid_at AS "paidAt", l.payment_reference AS "paymentReference"
       FROM pay_lines l JOIN pay_runs r ON r.id = l.run_id
       WHERE l.user_id = $1 AND r.status <> 'draft'
       ORDER BY r.period_start DESC LIMIT 24`,
      [user.id],
    );
    const adjustments = await this.db.manager.query<
      { runId: string; amount: number; reason: string }[]
    >(
      `SELECT run_id AS "runId", amount, reason FROM pay_adjustments
       WHERE user_id = $1 AND status = 'approved'`,
      [user.id],
    );
    return {
      current: { ...current, line: current.lines[0] ?? null, lines: undefined },
      history: history.map((h) => ({
        ...h,
        label: periodLabel(h.period, {
          start: h.periodStart,
          end: h.periodEnd,
        }),
        adjustmentsDetail: adjustments.filter((a) => a.runId === h.runId),
      })),
    };
  }

  /** Tâche planifiée : la paie de la période écoulée est préparée en brouillon pour l'administrateur. */
  async prepareDraft(): Promise<void> {
    const { period: kind } = await this.settings();
    const period = previousPeriod(kind, await this.today());
    const exists = await this.db.manager.findOneBy(PayRun, {
      periodStart: period.start,
      periodEnd: period.end,
    });
    if (exists) return;
    if (!(await this.db.manager.countBy(PayGrid, { isActive: true }))) return;
    const run = await this.createRun(period.start);
    const label = periodLabel(kind, period);
    await this.notifications.notify(await this.access.adminIds(), {
      type: 'pay.draft_ready',
      title: 'Paie à valider',
      body: `La paie de ${label} est calculée : vérifiez-la puis validez-la.`,
      data: { runId: run.id },
    });
    this.logger.log(`Structure ${this.db.tenantId} : paie ${label} préparée`);
  }
}
