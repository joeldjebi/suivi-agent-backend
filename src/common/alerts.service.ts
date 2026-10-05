import { Injectable } from '@nestjs/common';
import {
  type AgentAlertInfo,
  AlertType,
  DayStatus,
  SocketEvent,
} from '@suivi/shared';
import { type FindOptionsWhere, In, IsNull } from 'typeorm';
import { AgentAlert, TenantSettings, User } from '../entities';
import { AccessService } from './access.service';
import { DbService } from './db.service';
import { NotificationsService } from './notifications.service';
import { RealtimeService, statusRooms } from './realtime.service';
import { workDate } from './time.util';

/** Délai après lequel l'alerte « journée pas démarrée » n'est plus envoyée (réglage tardif). */
const LATE_WINDOW_MINUTES = 180;
/** Batterie : l'alerte se referme une fois rechargée de 15 points au-dessus du seuil. */
const BATTERY_HYSTERESIS = 15;
/** Agents concernés par « journée pas démarrée » : ceux qui ont travaillé ces 30 derniers jours. */
const RECENT_DAYS = 30;

type AgentRef = Pick<User, 'id' | 'firstName' | 'lastName' | 'groupId'>;

const TITLES: Record<AlertType, string> = {
  [AlertType.SignalLost]: 'signal perdu',
  [AlertType.Immobile]: 'immobile',
  [AlertType.LowBattery]: 'batterie faible',
  [AlertType.Mocked]: 'position simulée',
  [AlertType.OutOfZone]: 'hors zone',
  [AlertType.LateStart]: 'journée pas démarrée',
};

/**
 * Alertes intelligentes des responsables. Le planificateur passe chaque minute : une alerte
 * s'ouvre quand la situation apparaît (le responsable est prévenu), se referme d'elle-même
 * quand elle se règle, et peut être « prise en charge » par un responsable.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Passage du planificateur pour une structure. */
  async scan(settings: TenantSettings, now = new Date()): Promise<void> {
    await this.scanDays(settings, now);
    await this.scanLateStarts(settings, now);
  }

  /** Ouvre une alerte (s'il n'y en a pas déjà une ouverte du même type) et prévient. */
  async open(
    agent: AgentRef,
    type: AlertType,
    dayId: string | null,
    data: Record<string, unknown>,
    options: { notify?: boolean; at?: Date } = {},
  ): Promise<AgentAlert | null> {
    const [row] = await this.db.manager.query<{ id: string }[]>(
      `INSERT INTO agent_alerts (tenant_id, agent_id, day_id, type, started_at, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_id, type) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      [
        this.db.tenantId,
        agent.id,
        dayId,
        type,
        options.at ?? new Date(),
        JSON.stringify(data),
      ],
    );
    if (!row) return null;
    const alert = await this.db.manager.findOneByOrFail(AgentAlert, {
      id: row.id,
    });
    if (options.notify !== false) {
      const recipients = await this.access.approverIds(
        await this.access.getAgent(agent.id),
        await this.access.settings(),
      );
      await this.notifications.notify(recipients, {
        type: `alert.${type}`,
        title: `${agent.firstName} ${agent.lastName} : ${TITLES[type]}`,
        body: describe(type, data),
        data: { alertId: alert.id, agentId: agent.id, type },
      });
    }
    await this.emit(alert, agent);
    return alert;
  }

  /** Referme l'alerte ouverte de ce type pour l'agent. */
  async resolve(agentId: string, type: AlertType, at = new Date()) {
    await this.resolveWhere({ agentId, type, resolvedAt: IsNull() }, at);
  }

  /** Fin de journée : les alertes liées à la journée n'ont plus d'objet. */
  async resolveDay(dayId: string, at = new Date()) {
    await this.resolveWhere({ dayId, resolvedAt: IsNull() }, at);
  }

  private async resolveWhere(where: FindOptionsWhere<AgentAlert>, at: Date) {
    const m = this.db.manager;
    const open = await m.find(AgentAlert, { where });
    if (!open.length) return;
    await m.update(
      AgentAlert,
      { id: In(open.map((a) => a.id)) },
      { resolvedAt: at },
    );
    for (const alert of open) {
      alert.resolvedAt = at;
      await this.emit(alert);
    }
  }

  /** Alertes liées aux journées en cours : signal, immobilité, batterie, fausse position. */
  private async scanDays(settings: TenantSettings, now: Date) {
    const m = this.db.manager;
    const rows = await m.query<
      {
        dayId: string;
        status: DayStatus;
        startedAt: Date;
        agentId: string;
        firstName: string;
        lastName: string;
        groupId: string | null;
        lastAt: Date | null;
        battery: number | null;
        mocked: boolean;
      }[]
    >(
      `SELECT d.id AS "dayId", d.status, d.started_at AS "startedAt", u.id AS "agentId",
              u.first_name AS "firstName", u.last_name AS "lastName", u.group_id AS "groupId",
              last.recorded_at AS "lastAt", last.battery_level AS battery,
              EXISTS (SELECT 1 FROM positions p WHERE p.day_id = d.id AND p.is_mocked) AS mocked
       FROM work_days d
       JOIN users u ON u.id = d.agent_id
       LEFT JOIN LATERAL (
         SELECT p.recorded_at, p.battery_level FROM positions p
         WHERE p.day_id = d.id ORDER BY p.recorded_at DESC LIMIT 1
       ) last ON true
       WHERE d.status IN ('active', 'paused')`,
    );

    const immobile = settings.alertImmobileMinutes
      ? await this.immobileDays(settings, now)
      : new Map<string, { since: Date; spread: number }>();

    for (const r of rows) {
      const agent: AgentRef = {
        id: r.agentId,
        firstName: r.firstName,
        lastName: r.lastName,
        groupId: r.groupId,
      };
      const active = r.status === DayStatus.Active;

      // Signal perdu : journée en cours (hors pause) sans position récente.
      const lostAfter = now.getTime() - settings.signalLostMinutes * 60_000;
      const lost =
        settings.alertSignalLost &&
        active &&
        new Date(r.startedAt).getTime() < lostAfter &&
        (!r.lastAt || new Date(r.lastAt).getTime() < lostAfter);
      if (lost)
        await this.open(agent, AlertType.SignalLost, r.dayId, {
          lastPositionAt: r.lastAt ? new Date(r.lastAt).toISOString() : null,
        });
      else await this.resolve(agent.id, AlertType.SignalLost, now);

      // Immobile (hors pause).
      const still = active ? immobile.get(r.dayId) : undefined;
      if (still)
        await this.open(agent, AlertType.Immobile, r.dayId, {
          since: still.since.toISOString(),
          radiusM: settings.alertImmobileRadiusM,
        });
      else await this.resolve(agent.id, AlertType.Immobile, now);

      // Batterie faible ; refermée une fois rechargée nettement au-dessus du seuil.
      const percent = r.battery === null ? null : Math.round(r.battery * 100);
      if (settings.alertBatteryPercent && percent !== null) {
        if (percent <= settings.alertBatteryPercent)
          await this.open(agent, AlertType.LowBattery, r.dayId, {
            percent,
          });
        else if (percent >= settings.alertBatteryPercent + BATTERY_HYSTERESIS)
          await this.resolve(agent.id, AlertType.LowBattery, now);
      }

      // Fausse position : jusqu'à la fin de la journée.
      if (settings.alertMocked && r.mocked)
        await this.open(agent, AlertType.Mocked, r.dayId, {});
    }
  }

  /**
   * Journées en cours où l'agent n'a pas bougé au-delà du rayon pendant le délai : il faut
   * assez de positions couvrant la période (relevé de contrôle toutes les 3 minutes).
   */
  private async immobileDays(settings: TenantSettings, now: Date) {
    const minutes = settings.alertImmobileMinutes!;
    const rows = await this.db.manager.query<
      { dayId: string; since: Date; spread: number }[]
    >(
      `WITH w AS (
         SELECT p.day_id, p.location, p.recorded_at
         FROM positions p JOIN work_days d ON d.id = p.day_id AND d.status = 'active'
         WHERE p.recorded_at >= $1::timestamptz - make_interval(mins => $2)
           AND p.recorded_at <= $1::timestamptz
           AND d.started_at <= $1::timestamptz - make_interval(mins => $2)
       ), c AS (
         SELECT day_id, ST_Centroid(ST_Collect(location)) AS center,
                min(recorded_at) AS first, count(*) AS n
         FROM w GROUP BY day_id
       )
       SELECT c.day_id AS "dayId", c.first AS since,
              max(ST_Distance(w.location::geography, c.center::geography))::float8 AS spread
       FROM c JOIN w USING (day_id)
       WHERE c.n >= 3 AND c.first <= $1::timestamptz - make_interval(mins => $3)
       GROUP BY c.day_id, c.first`,
      // La première position doit couvrir le début de la période (à 10 minutes près).
      [now.toISOString(), minutes, Math.max(1, minutes - 10)],
    );
    return new Map(
      rows
        .filter((r) => r.spread <= settings.alertImmobileRadiusM)
        .map((r) => [r.dayId, { since: new Date(r.since), spread: r.spread }]),
    );
  }

  /**
   * Journée pas démarrée : après l'heure attendue plus la marge, un jour travaillé, pour les
   * agents qui ont travaillé récemment. Un message groupé par responsable.
   */
  private async scanLateStarts(settings: TenantSettings, now: Date) {
    if (!settings.alertStartTime) return;
    const today = workDate(now, settings.timezone, settings.dailyResetTime);
    const weekday = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    if (!settings.alertWorkdays.includes(weekday)) return;

    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now);
    const toMinutes = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    const late =
      toMinutes(local) -
      toMinutes(settings.alertStartTime) -
      settings.alertLateMinutes;
    if (late < 0 || late > LATE_WINDOW_MINUTES) return;

    const agents = await this.db.manager.query<AgentRef[]>(
      `SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName", u.group_id AS "groupId"
       FROM users u
       WHERE u.role = 'agent' AND u.is_active
         AND EXISTS (SELECT 1 FROM work_days d WHERE d.agent_id = u.id
                     AND d.work_date >= $1::date - $2::int AND d.work_date < $1::date)
         AND NOT EXISTS (SELECT 1 FROM work_days d WHERE d.agent_id = u.id AND d.work_date = $1::date)
         AND NOT EXISTS (SELECT 1 FROM agent_alerts a WHERE a.agent_id = u.id
                         AND a.type = 'late_start' AND a.data ->> 'date' = $3)
       ORDER BY u.last_name, u.first_name`,
      [today, RECENT_DAYS, today],
    );
    if (!agents.length) return;

    const settingsNow = await this.access.settings();
    const byRecipient = new Map<string, AgentRef[]>();
    for (const agent of agents) {
      const opened = await this.open(
        agent,
        AlertType.LateStart,
        null,
        { date: today, expectedAt: settings.alertStartTime },
        { notify: false },
      );
      if (!opened) continue;
      const recipients = await this.access.approverIds(
        await this.access.getAgent(agent.id),
        settingsNow,
      );
      for (const id of recipients)
        byRecipient.set(id, [...(byRecipient.get(id) ?? []), agent]);
    }
    for (const [recipient, list] of byRecipient) {
      const names = list.map((a) => `${a.firstName} ${a.lastName}`);
      await this.notifications.notify([recipient], {
        type: `alert.${AlertType.LateStart}`,
        title:
          list.length === 1
            ? `${names[0]} : journée pas démarrée`
            : `${list.length} agents n’ont pas démarré leur journée`,
        body: `Début attendu à ${settings.alertStartTime}. ${
          list.length === 1
            ? ''
            : `${names.slice(0, 5).join(', ')}${list.length > 5 ? '…' : ''}.`
        }`.trim(),
        data: { type: AlertType.LateStart, agentIds: list.map((a) => a.id) },
      });
    }
  }

  /** Réinitialisation quotidienne : les retards de la veille n'ont plus d'objet. */
  async resolveLateStarts(at = new Date()) {
    await this.resolveWhere(
      { type: AlertType.LateStart, resolvedAt: IsNull() },
      at,
    );
  }

  private async emit(alert: AgentAlert, agent?: AgentRef) {
    const who =
      agent ??
      (await this.db.manager.findOneOrFail(User, {
        where: { id: alert.agentId },
        select: { id: true, firstName: true, lastName: true, groupId: true },
      }));
    const tenantId = this.db.tenantId;
    const payload = {
      id: alert.id,
      type: alert.type,
      agentId: alert.agentId,
      resolvedAt: alert.resolvedAt,
    };
    this.db.afterCommit(() =>
      this.realtime.emit(
        statusRooms(tenantId, who),
        SocketEvent.AgentAlert,
        payload,
      ),
    );
  }

  /** Format de l'API, avec l'agent et le responsable qui a pris l'alerte en charge. */
  async toInfo(alerts: AgentAlert[]): Promise<AgentAlertInfo[]> {
    const ids = [
      ...new Set(
        alerts.flatMap((a) => [a.agentId, a.acknowledgedById ?? a.agentId]),
      ),
    ];
    const users = ids.length
      ? await this.db.manager.find(User, {
          where: { id: In(ids) },
          select: { id: true, firstName: true, lastName: true, groupId: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return alerts.map((a) => {
      const agent = byId.get(a.agentId)!;
      const ack = a.acknowledgedById ? byId.get(a.acknowledgedById) : null;
      return {
        id: a.id,
        type: a.type,
        agent: {
          id: agent.id,
          firstName: agent.firstName,
          lastName: agent.lastName,
          groupId: agent.groupId,
        },
        dayId: a.dayId,
        startedAt: a.startedAt.toISOString(),
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
        data: a.data,
        acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
        acknowledgedBy: ack
          ? { id: ack.id, firstName: ack.firstName, lastName: ack.lastName }
          : null,
        note: a.note,
      };
    });
  }
}

/** Phrase du message envoyé au responsable. */
function describe(type: AlertType, data: Record<string, unknown>): string {
  switch (type) {
    case AlertType.SignalLost:
      return 'Plus aucune position : GPS coupé, application fermée ou réseau absent.';
    case AlertType.Immobile: {
      const minutes = Math.max(
        1,
        Math.round((Date.now() - Date.parse(String(data.since))) / 60_000),
      );
      return `Aucun déplacement au-delà de ${String(data.radiusM)} m depuis ${minutes} min.`;
    }
    case AlertType.LowBattery:
      return `Batterie à ${String(data.percent)} % : le suivi risque de s’arrêter.`;
    case AlertType.Mocked:
      return 'Une application de fausse position GPS est utilisée.';
    case AlertType.OutOfZone:
      return 'Hors de sa zone au-delà du délai d’alerte.';
    case AlertType.LateStart:
      return `Début attendu à ${String(data.expectedAt)}.`;
  }
}
