import { Injectable } from '@nestjs/common';
import { Role } from '@suivi/shared';
import { AccessService } from '../common/access.service';
import { badRequest, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { workDate } from '../common/time.util';
import { User } from '../entities';
import type {
  LeadStats,
  PeriodQuery,
  TimelineEvent,
  TimelineQuery,
} from './team-leads.dto';
import { TIMELINE_TYPES } from './team-leads.dto';

/** Bornes de la période en dates de la structure : [from, to + 1 jour). */
interface Period {
  from: string;
  to: string;
  timezone: string;
}

/** Chefs d'équipe vus par l'administrateur : réactivité, encadrement, présence, équipe. */
@Injectable()
export class TeamLeadsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async period(query: PeriodQuery): Promise<Period> {
    const settings = await this.access.settings();
    const today = workDate(
      new Date(),
      settings.timezone,
      settings.dailyResetTime,
    );
    const to = query.to ?? today;
    const from =
      query.from ??
      new Date(Date.parse(`${to}T12:00:00Z`) - 29 * 86400_000)
        .toISOString()
        .slice(0, 10);
    if (from > to)
      throw badRequest(
        'INVALID_PERIOD',
        'La date de début doit précéder la date de fin',
      );
    return { from, to, timezone: settings.timezone };
  }

  async list(query: PeriodQuery) {
    const period = await this.period(query);
    return { ...period, leads: await this.stats(period) };
  }

  async get(id: string, query: PeriodQuery) {
    const period = await this.period(query);
    const [lead] = await this.stats(period, id);
    if (!lead) throw notFound("Chef d'équipe");
    const agents = await this.db.manager.query<
      {
        id: string;
        firstName: string;
        lastName: string;
        groupName: string;
        days: number;
        lastDay: string | null;
      }[]
    >(
      `SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName", g.name AS "groupName",
              count(d.id)::int AS days, to_char(max(d.work_date), 'YYYY-MM-DD') AS "lastDay"
       FROM groups g
       JOIN users u ON u.group_id = g.id AND u.role = 'agent' AND u.is_active
       LEFT JOIN work_days d ON d.agent_id = u.id AND d.work_date BETWEEN $2::date AND $3::date
       WHERE g.leader_id = $1
       GROUP BY u.id, g.name
       ORDER BY u.last_name, u.first_name`,
      [id, period.from, period.to],
    );
    return { ...period, lead, agents };
  }

  /** Fil des actions d'un chef, de la plus récente à la plus ancienne. */
  async timeline(id: string, query: TimelineQuery) {
    const period = await this.period(query);
    const lead = await this.db.manager.findOneBy(User, {
      id,
      role: Role.TeamLead,
    });
    if (!lead) throw notFound("Chef d'équipe");
    const types = query.types?.length ? query.types : [...TIMELINE_TYPES];
    const params = [
      id,
      period.from,
      period.to,
      period.timezone,
      types,
      query.limit,
      (query.page - 1) * query.limit,
    ];
    // Bornes en heure de la structure.
    const inPeriod = (col: string) =>
      `${col} >= ($2::date)::timestamp AT TIME ZONE $4 AND ${col} < ($3::date + 1)::timestamp AT TIME ZONE $4`;
    const events = `
      SELECT 'login' AS type, a.created_at AS at, NULL::uuid AS agent_id, NULL::text AS zone,
             NULL::uuid AS mission_id, NULL::text AS detail, NULL::float8 AS response
      FROM audit_logs a WHERE a.user_id = $1 AND a.action = 'auth.login' AND ${inPeriod('a.created_at')}
      UNION ALL
      SELECT CASE WHEN r.decision_reason LIKE 'reassigned%' THEN 'zone.reassigned'
                  WHEN r.status = 'rejected' THEN 'zone.rejected'
                  ELSE 'zone.approved' END,
             r.decided_at, r.agent_id, z.name, NULL,
             CASE WHEN r.status = 'rejected' THEN r.decision_reason END,
             CASE WHEN r.decision_reason LIKE 'reassigned%' THEN NULL
                  ELSE extract(epoch FROM r.decided_at - r.created_at) END
      FROM zone_requests r JOIN zones z ON z.id = r.zone_id
      WHERE r.decided_by_id = $1 AND ${inPeriod('r.decided_at')}
      UNION ALL
      SELECT 'zone.unanswered', coalesce(r.decided_at, r.released_at), r.agent_id, z.name, NULL,
             CASE WHEN r.status = 'expired' THEN 'Demande expirée' ELSE 'Validée automatiquement' END,
             NULL
      FROM zone_requests r
      JOIN zones z ON z.id = r.zone_id
      JOIN users u ON u.id = r.agent_id
      JOIN groups g ON g.id = u.group_id AND g.leader_id = $1
      WHERE r.requires_approval
        AND (r.status = 'expired' OR r.decision_reason = 'expired_auto_approved')
        AND ${inPeriod('coalesce(r.decided_at, r.released_at)')}
      UNION ALL
      SELECT 'submission.rejected', s.rejected_at, s.agent_id, NULL, s.mission_id, s.rejected_reason, NULL
      FROM mission_submissions s
      WHERE s.rejected_by_id = $1 AND s.rejected_at IS NOT NULL AND ${inPeriod('s.rejected_at')}
      UNION ALL
      SELECT 'mission.created', m.created_at, m.assignee_agent_id, NULL, m.id,
             (SELECT name FROM groups WHERE id = m.assignee_group_id), NULL
      FROM missions m WHERE m.created_by_id = $1 AND ${inPeriod('m.created_at')}
      UNION ALL
      SELECT 'mission.result', a.created_at, NULL, NULL, m.id, NULL, NULL
      FROM audit_logs a
      JOIN missions m ON m.id::text = substring(a.path FROM '/missions/([0-9a-f-]{36})/result')
      WHERE a.user_id = $1 AND a.action = 'MissionsController.setManualResult'
        AND a.status_code < 300 AND ${inPeriod('a.created_at')}`;

    const rows = await this.db.manager.query<
      {
        type: TimelineEvent['type'];
        at: Date;
        agent_id: string | null;
        agent_name: string | null;
        zone: string | null;
        mission_id: string | null;
        mission_title: string | null;
        detail: string | null;
        response: number | null;
        total: number;
      }[]
    >(
      `WITH events AS (${events})
       SELECT e.type, e.at, e.agent_id, u.first_name || ' ' || u.last_name AS agent_name,
              e.zone, e.mission_id, m.title AS mission_title, e.detail, e.response,
              count(*) OVER ()::int AS total
       FROM events e
       LEFT JOIN users u ON u.id = e.agent_id
       LEFT JOIN missions m ON m.id = e.mission_id
       WHERE e.type = ANY($5::text[])
       ORDER BY e.at DESC
       LIMIT $6 OFFSET $7`,
      params,
    );
    const items: TimelineEvent[] = rows.map((r) => ({
      type: r.type,
      at: new Date(r.at).toISOString(),
      agent: r.agent_id ? { id: r.agent_id, name: r.agent_name ?? '' } : null,
      zone: r.zone,
      mission: r.mission_id
        ? { id: r.mission_id, title: r.mission_title ?? '' }
        : null,
      detail: r.detail,
      responseSeconds: r.response === null ? null : Math.round(r.response),
    }));
    return {
      ...period,
      items,
      total: rows[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  private async stats(period: Period, onlyId?: string): Promise<LeadStats[]> {
    const inPeriod = (col: string) =>
      `${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE $3`;
    return this.db.manager.query<LeadStats[]>(
      `WITH leads AS (
         SELECT * FROM users WHERE role = 'team_lead' AND ($4::uuid IS NULL OR id = $4)
       ),
       team AS (
         SELECT g.leader_id, u.id AS agent_id
         FROM groups g JOIN users u ON u.group_id = g.id AND u.role = 'agent' AND u.is_active
         WHERE g.leader_id IS NOT NULL
       ),
       received AS (
         SELECT t.leader_id,
                count(*) FILTER (WHERE ${inPeriod('r.created_at')})::int AS received,
                count(*) FILTER (WHERE (r.status = 'expired' OR r.decision_reason = 'expired_auto_approved')
                                   AND ${inPeriod('coalesce(r.decided_at, r.released_at)')})::int AS unanswered,
                count(*) FILTER (WHERE r.status = 'pending')::int AS pending
         FROM zone_requests r JOIN team t ON t.agent_id = r.agent_id
         WHERE r.requires_approval
         GROUP BY t.leader_id
       ),
       decided AS (
         SELECT r.decided_by_id AS leader_id,
                count(*) FILTER (WHERE r.decision_reason IS DISTINCT FROM 'reassigned'
                                   AND r.decision_reason IS DISTINCT FROM 'reassigned_over_capacity')::int AS decided,
                count(*) FILTER (WHERE r.status = 'rejected')::int AS rejected,
                avg(extract(epoch FROM r.decided_at - r.created_at)) FILTER (
                  WHERE r.requires_approval AND r.decision_reason NOT LIKE 'reassigned%') AS avg_response,
                count(*) FILTER (WHERE r.decision_reason LIKE 'reassigned%')::int AS reassignments
         FROM zone_requests r
         WHERE r.decided_by_id IS NOT NULL AND ${inPeriod('r.decided_at')}
         GROUP BY r.decided_by_id
       ),
       forms AS (
         SELECT rejected_by_id AS leader_id, count(*)::int AS rejected
         FROM mission_submissions
         WHERE rejected_by_id IS NOT NULL AND rejected_at IS NOT NULL AND ${inPeriod('rejected_at')}
         GROUP BY rejected_by_id
       ),
       created AS (
         SELECT created_by_id AS leader_id, count(*)::int AS missions
         FROM missions WHERE created_by_id IS NOT NULL AND ${inPeriod('created_at')}
         GROUP BY created_by_id
       ),
       activity AS (
         SELECT a.user_id AS leader_id,
                count(*) FILTER (WHERE a.action = 'auth.login' AND ${inPeriod('a.created_at')})::int AS logins,
                count(DISTINCT (a.created_at AT TIME ZONE $3)::date) FILTER (
                  WHERE a.action = 'auth.login' AND ${inPeriod('a.created_at')})::int AS login_days,
                max(a.created_at) FILTER (WHERE a.action = 'auth.login') AS last_login,
                max(a.created_at) AS last_activity
         FROM audit_logs a JOIN leads l ON l.id = a.user_id
         GROUP BY a.user_id
       ),
       team_days AS (
         SELECT t.leader_id, count(d.id)::int AS days, count(DISTINCT d.agent_id)::int AS active_agents
         FROM team t JOIN work_days d ON d.agent_id = t.agent_id
         WHERE d.work_date BETWEEN $1::date AND $2::date
         GROUP BY t.leader_id
       )
       SELECT l.id, l.first_name AS "firstName", l.last_name AS "lastName", l.email, l.phone,
              l.is_active AS "isActive", l.avatar_version AS "avatarVersion",
              coalesce((SELECT json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
                        FROM groups g WHERE g.leader_id = l.id AND g.is_active), '[]') AS groups,
              (SELECT count(*)::int FROM team t WHERE t.leader_id = l.id) AS agents,
              coalesce(rc.received, 0) AS "requestsReceived",
              coalesce(dc.decided, 0) AS "requestsDecided",
              coalesce(dc.rejected, 0) AS "requestsRejected",
              round(dc.avg_response)::int AS "avgResponseSeconds",
              coalesce(rc.unanswered, 0) AS "requestsUnanswered",
              coalesce(rc.pending, 0) AS "requestsPending",
              coalesce(dc.reassignments, 0) AS reassignments,
              coalesce(f.rejected, 0) AS "formsRejected",
              coalesce(c.missions, 0) AS "missionsCreated",
              coalesce(a.logins, 0) AS logins,
              coalesce(a.login_days, 0) AS "loginDays",
              a.last_login AS "lastLoginAt",
              a.last_activity AS "lastActivityAt",
              coalesce(td.days, 0) AS "teamDays",
              coalesce(td.active_agents, 0) AS "teamActiveAgents"
       FROM leads l
       LEFT JOIN received rc ON rc.leader_id = l.id
       LEFT JOIN decided dc ON dc.leader_id = l.id
       LEFT JOIN forms f ON f.leader_id = l.id
       LEFT JOIN created c ON c.leader_id = l.id
       LEFT JOIN activity a ON a.leader_id = l.id
       LEFT JOIN team_days td ON td.leader_id = l.id
       ORDER BY l.last_name, l.first_name`,
      [period.from, period.to, period.timezone, onlyId ?? null],
    );
  }
}
