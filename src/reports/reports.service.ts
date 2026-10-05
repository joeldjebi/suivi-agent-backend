import { Injectable } from '@nestjs/common';
import { type DailyReport, type DailyReportAgent, Role } from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { workDate } from '../common/time.util';
import { workedDaysCte } from '../common/worked-days.sql';
import { TenantSettings, User } from '../entities';
import type { DailyReportQuery, TeamMessageDto } from './reports.dto';

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Bilan de fin de journée des responsables (qui a travaillé, combien de temps, formulaires,
 * sorties de zone, alertes) et messages du chef à son équipe.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  async daily(user: AuthUser, query: DailyReportQuery): Promise<DailyReport> {
    const settings = await this.access.settings();
    const date =
      query.date ??
      workDate(new Date(), settings.timezone, settings.dailyResetTime);
    const scope = await this.access.agentScope(user);
    return this.build(settings, date, scope, query.groupId ?? null);
  }

  /** Bilan d'un jour pour des agents (null : toute la structure). */
  private async build(
    settings: TenantSettings,
    date: string,
    scope: string[] | null,
    groupId: string | null,
  ): Promise<DailyReport> {
    const m = this.db.manager;
    const tz = settings.timezone;
    const agents = await m.query<
      {
        id: string;
        firstName: string;
        lastName: string;
        phone: string | null;
        group: string | null;
      }[]
    >(
      `SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName", u.phone, g.name AS "group"
       FROM users u LEFT JOIN groups g ON g.id = u.group_id
       WHERE u.role = 'agent' AND u.is_active
         AND ($1::uuid[] IS NULL OR u.id = ANY($1::uuid[]))
         AND ($2::uuid IS NULL OR u.group_id = $2)
       ORDER BY u.last_name, u.first_name`,
      [scope, groupId],
    );
    const ids = agents.map((a) => a.id);
    const days = ids.length
      ? await m.query<Record<string, unknown>[]>(
          `WITH ${workedDaysCte(`d.work_date = $1::date AND d.agent_id = ANY($2::uuid[])`)}
           SELECT d.agent_id AS "agentId", wd.status, wd.end_reason AS "endReason", z.name AS zone,
                  d.started_at AS "startedAt", wd.ended_at AS "endedAt", d.worked,
                  to_char(d.started_at AT TIME ZONE $3, 'HH24:MI') AS "localStart",
                  (SELECT coalesce(sum(extract(epoch FROM coalesce(p.ended_at, now()) - p.started_at)), 0)
                     FROM day_pauses p WHERE p.day_id = d.id) AS pauses,
                  (SELECT count(*) FROM zone_exits e WHERE e.day_id = d.id)::int AS exits,
                  (SELECT coalesce(sum(extract(epoch FROM coalesce(e.ended_at, now()) - e.exited_at)), 0)
                     FROM zone_exits e WHERE e.day_id = d.id) AS outside
           FROM days d JOIN work_days wd ON wd.id = d.id LEFT JOIN zones z ON z.id = d.zone_id
           ORDER BY d.started_at`,
          [date, ids, tz],
        )
      : [];
    const forms = ids.length
      ? await m.query<
          { agentId: string; accepted: number; rejected: number }[]
        >(
          `SELECT agent_id AS "agentId",
                  count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
                  count(*) FILTER (WHERE status = 'rejected')::int AS rejected
           FROM mission_submissions
           WHERE agent_id = ANY($1::uuid[]) AND (submitted_at AT TIME ZONE $2)::date = $3::date
           GROUP BY agent_id`,
          [ids, tz, date],
        )
      : [];
    const alerts = ids.length
      ? await m.query<{ agentId: string; types: string[] }[]>(
          `SELECT agent_id AS "agentId", array_agg(DISTINCT type) AS types
           FROM agent_alerts
           WHERE agent_id = ANY($1::uuid[])
             AND ((started_at AT TIME ZONE $2)::date = $3::date OR data ->> 'date' = $4)
           GROUP BY agent_id`,
          [ids, tz, date, date],
        )
      : [];

    const lateAfter = settings.alertStartTime
      ? toMinutes(settings.alertStartTime) + settings.alertLateMinutes
      : null;
    const rows: DailyReportAgent[] = agents.map((a) => {
      const own = days.filter((d) => d.agentId === a.id);
      const first = own[0];
      const last = own[own.length - 1];
      const f = forms.find((x) => x.agentId === a.id);
      const working = own.some((d) => d.status !== 'ended');
      const status: DailyReportAgent['status'] = !first
        ? 'not_started'
        : working
          ? 'working'
          : own.some((d) => d.endReason === 'auto_reset')
            ? 'auto'
            : 'ended';
      const sum = (key: string) =>
        own.reduce((s, d) => s + Number(d[key] ?? 0), 0);
      return {
        ...a,
        status,
        zone: (last?.zone as string | null) ?? null,
        startedAt: first
          ? new Date(first.startedAt as string).toISOString()
          : null,
        endedAt:
          last && !working && last.endedAt
            ? new Date(last.endedAt as string).toISOString()
            : null,
        workedMinutes: Math.round(sum('worked') / 60),
        pausesMinutes: Math.round(sum('pauses') / 60),
        formsAccepted: f?.accepted ?? 0,
        formsRejected: f?.rejected ?? 0,
        zoneExits: sum('exits'),
        outsideMinutes: Math.round(sum('outside') / 60),
        alerts: alerts.find((x) => x.agentId === a.id)?.types ?? [],
        late:
          lateAfter !== null &&
          !!first &&
          toMinutes(first.localStart as string) > lateAfter,
      };
    });
    const total = (pick: (r: DailyReportAgent) => number) =>
      rows.reduce((s, r) => s + pick(r), 0);
    return {
      date,
      summary: {
        agents: rows.length,
        worked: rows.filter((r) => r.status !== 'not_started').length,
        notStarted: rows.filter((r) => r.status === 'not_started').length,
        late: rows.filter((r) => r.late).length,
        workedMinutes: total((r) => r.workedMinutes),
        formsAccepted: total((r) => r.formsAccepted),
        formsRejected: total((r) => r.formsRejected),
        zoneExits: total((r) => r.zoneExits),
        alerts: total((r) => r.alerts.length),
        autoClosed: rows.filter((r) => r.status === 'auto').length,
      },
      agents: rows,
    };
  }

  /**
   * Planificateur : à l'heure réglée, chaque responsable reçoit le bilan de son équipe (une
   * fois par jour). Rien n'est envoyé pour une équipe vide.
   */
  async sendDailyReports(settings: TenantSettings, now = new Date()) {
    if (!settings.dailyReportTime) return 0;
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now);
    const late = toMinutes(local) - toMinutes(settings.dailyReportTime);
    if (late < 0 || late > 120) return 0;
    const date = workDate(now, settings.timezone, settings.dailyResetTime);
    const m = this.db.manager;
    const [{ last }] = await m.query<{ last: string | null }[]>(
      `SELECT to_char(last_report_date, 'YYYY-MM-DD') AS last FROM tenant_settings WHERE tenant_id = $1`,
      [settings.tenantId],
    );
    if (last === date) return 0;
    await m.query(
      `UPDATE tenant_settings SET last_report_date = $2 WHERE tenant_id = $1`,
      [settings.tenantId, date],
    );

    const managers = await m.find(User, {
      select: { id: true, role: true },
      where: [
        { role: Role.Admin, isActive: true },
        { role: Role.TeamLead, isActive: true },
      ],
    });
    let sent = 0;
    for (const manager of managers) {
      const scope = await this.access.agentScope({
        id: manager.id,
        role: manager.role,
        tenantId: settings.tenantId,
        email: '',
      });
      const report = await this.build(settings, date, scope, null);
      if (!report.summary.agents) continue;
      const s = report.summary;
      const hours = Math.round(s.workedMinutes / 6) / 10;
      await this.notifications.notify([manager.id], {
        type: 'report.daily',
        title: 'Bilan de la journée',
        body: [
          `${s.worked}/${s.agents} agents ont travaillé (${hours.toLocaleString('fr-FR')} h)`,
          `${s.formsAccepted} formulaire${s.formsAccepted > 1 ? 's' : ''}`,
          s.alerts ? `${s.alerts} alerte${s.alerts > 1 ? 's' : ''}` : null,
          s.notStarted
            ? `${s.notStarted} absent${s.notStarted > 1 ? 's' : ''}`
            : null,
        ]
          .filter(Boolean)
          .join(' · '),
        data: { date },
      });
      sent++;
    }
    return sent;
  }

  // ------------------------------------------------------------ messages

  /** Message du chef à son équipe : chaque agent le reçoit en notification. */
  async sendMessage(user: AuthUser, dto: TeamMessageDto) {
    const m = this.db.manager;
    const scope = await this.access.agentScope(user);
    const team = (
      await m.query<{ id: string }[]>(
        `SELECT id FROM users WHERE role = 'agent' AND is_active
           AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))`,
        [scope],
      )
    ).map((r) => r.id);
    const recipients = dto.agentIds?.length
      ? dto.agentIds.filter((id) => team.includes(id))
      : team;
    if (
      dto.agentIds?.length &&
      recipients.length !== new Set(dto.agentIds).size
    )
      throw badRequest(
        'NOT_IN_TEAM',
        'Certains destinataires ne font pas partie de votre équipe',
      );
    if (!recipients.length)
      throw badRequest('NO_RECIPIENT', 'Aucun agent à qui envoyer ce message');
    const author = await m.findOneByOrFail(User, { id: user.id });
    const body = dto.body.trim();
    const [saved] = await m.query<{ id: string; createdAt: Date }[]>(
      `INSERT INTO team_messages (tenant_id, author_id, body, recipient_ids)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at AS "createdAt"`,
      [this.db.tenantId, user.id, body, recipients],
    );
    await this.notifications.notify(recipients, {
      type: 'team.message',
      title: `Message de ${author.firstName} ${author.lastName}`,
      body,
      data: { messageId: saved.id },
    });
    return {
      id: saved.id,
      recipients: recipients.length,
      createdAt: saved.createdAt,
    };
  }

  /** Messages envoyés par l'utilisateur (les 50 derniers). */
  myMessages(user: AuthUser) {
    return this.db.manager.query(
      `SELECT id, body, cardinality(recipient_ids) AS recipients, created_at AS "createdAt"
       FROM team_messages WHERE author_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [user.id],
    );
  }
}
