import { Injectable } from '@nestjs/common';
import { MissionStatus } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { AccessService } from '../common/access.service';
import { badRequest } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { workDate } from '../common/time.util';
import { workedDaysCte } from '../common/worked-days.sql';
import { ListMissionsQuery } from '../missions/missions.dto';
import { MissionsService } from '../missions/missions.service';
import type { StatsQuery } from './stats.dto';

const DAY = 86400_000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY)
    .toISOString()
    .slice(0, 10);

/**
 * Filtres communs. Paramètres : $1 début, $2 fin (dates de la structure, incluses),
 * $3 fuseau horaire, $4 groupe, $5 agent, $6 zone (facultatifs).
 */
const AGENT_IN_GROUP = (col: string) =>
  `($4::uuid IS NULL OR ${col} IN (SELECT id FROM users WHERE group_id = $4)) AND ($5::uuid IS NULL OR ${col} = $5)`;
/** $6 : zone facultative (journées passées dans cette zone). */
const DAY_IN_ZONE = (dayCol: string) =>
  `($6::uuid IS NULL OR ${dayCol} IN (SELECT id FROM work_days WHERE zone_id = $6))`;
const IN_PERIOD = (col: string) =>
  `${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE $3`;
const DAYS_CTE = workedDaysCte(
  // $3 (fuseau) est typé ici : toutes les requêtes reçoivent les mêmes paramètres.
  `d.work_date BETWEEN $1::date AND $2::date AND $3::text IS NOT NULL AND ${AGENT_IN_GROUP('d.agent_id')}
   AND ($6::uuid IS NULL OR d.zone_id = $6)`,
);
/** Distance par journée : sauts de plus de 2 km ignorés (GPS imprécis). */
const DISTANCE_CTE = `segments AS (
  SELECT p.agent_id,
         coalesce(ST_DistanceSphere(p.location, lag(p.location) OVER w), 0) AS meters
  FROM positions p
  WHERE ${IN_PERIOD('p.recorded_at')} AND ${AGENT_IN_GROUP('p.agent_id')} AND ${DAY_IN_ZONE('p.day_id')}
  WINDOW w AS (PARTITION BY p.day_id ORDER BY p.recorded_at)
)`;

export interface Kpis {
  activeAgents: number;
  days: number;
  workedSeconds: number;
  forms: number;
  formsRejected: number;
  distanceKm: number;
}

/** Statistiques globales de la structure, sur une période comparée à la précédente. */
@Injectable()
export class StatsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly missions: MissionsService,
  ) {}

  async overview(user: AuthUser, query: StatsQuery) {
    const settings = await this.access.settings();
    const today = workDate(
      new Date(),
      settings.timezone,
      settings.dailyResetTime,
    );
    const to = query.to ?? today;
    const from = query.from ?? addDays(to, -29);
    if (from > to)
      throw badRequest(
        'INVALID_PERIOD',
        'La date de début doit précéder la date de fin',
      );
    const length = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
    if (length > 366)
      throw badRequest(
        'INVALID_PERIOD',
        'La période ne peut pas dépasser un an',
      );
    const previous = { from: addDays(from, -length), to: addDays(from, -1) };
    const filters = [
      query.groupId ?? null,
      query.agentId ?? null,
      query.zoneId ?? null,
    ];
    const params = [from, to, settings.timezone, ...filters];
    const q = <T>(sql: string, p: unknown[] = params) =>
      this.db.manager.query<T[]>(sql, p);

    // Requêtes successives : elles partagent la connexion de la transaction.
    const kpis = await this.kpis(params);
    const previousKpis = await this.kpis([
      previous.from,
      previous.to,
      settings.timezone,
      ...filters,
    ]);

    const [details] = await q<{
      totalAgents: number;
      avgStartMinutes: number | null;
      autoClosedDays: number;
      positions: number;
      outsidePositions: number;
      mockedPositions: number;
    }>(
      `WITH ${DAYS_CTE}
       SELECT
         (SELECT count(*)::int FROM users u
          WHERE u.role = 'agent' AND u.is_active AND ($4::uuid IS NULL OR u.group_id = $4)) AS "totalAgents",
         (SELECT round(avg(extract(hour FROM started_at AT TIME ZONE $3) * 60
                         + extract(minute FROM started_at AT TIME ZONE $3)))::int FROM days) AS "avgStartMinutes",
         (SELECT count(*)::int FROM days WHERE end_reason = 'auto_reset') AS "autoClosedDays",
         count(*)::int AS positions,
         count(*) FILTER (WHERE p.outside_zone)::int AS "outsidePositions",
         count(*) FILTER (WHERE p.is_mocked)::int AS "mockedPositions"
       FROM positions p
       WHERE ${IN_PERIOD('p.recorded_at')} AND ${AGENT_IN_GROUP('p.agent_id')} AND ${DAY_IN_ZONE('p.day_id')}`,
    );

    const [requests] = await q<{
      total: number;
      needingApproval: number;
      decided: number;
      rejected: number;
      unanswered: number;
      avgResponseSeconds: number | null;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE requires_approval)::int AS "needingApproval",
              count(*) FILTER (WHERE requires_approval AND decided_by_id IS NOT NULL)::int AS decided,
              count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              count(*) FILTER (WHERE requires_approval
                                 AND (status = 'expired' OR decision_reason = 'expired_auto_approved'))::int AS unanswered,
              round(avg(extract(epoch FROM decided_at - created_at)) FILTER (
                WHERE requires_approval AND decided_by_id IS NOT NULL
                  AND coalesce(decision_reason, '') NOT LIKE 'reassigned%'))::int AS "avgResponseSeconds"
       FROM zone_requests
       WHERE ${IN_PERIOD('created_at')} AND ${AGENT_IN_GROUP('agent_id')}
         AND ($6::uuid IS NULL OR zone_id = $6)`,
    );

    const daily = await q<{
      date: string;
      activeAgents: number;
      days: number;
      workedSeconds: number;
      forms: number;
    }>(
      `WITH ${DAYS_CTE},
       per_day AS (
         SELECT work_date, count(DISTINCT agent_id)::int AS agents, count(*)::int AS days,
                round(sum(worked))::int AS worked
         FROM days GROUP BY work_date
       ),
       forms AS (
         SELECT (submitted_at AT TIME ZONE $3)::date AS day, count(*)::int AS forms
         FROM mission_submissions
         WHERE status = 'accepted' AND ${IN_PERIOD('submitted_at')} AND ${AGENT_IN_GROUP('agent_id')}
           AND ${DAY_IN_ZONE('day_id')}
         GROUP BY 1
       )
       SELECT to_char(g::date, 'YYYY-MM-DD') AS date,
              coalesce(pd.agents, 0) AS "activeAgents", coalesce(pd.days, 0) AS days,
              coalesce(pd.worked, 0) AS "workedSeconds", coalesce(f.forms, 0) AS forms
       FROM generate_series($1::date, $2::date, interval '1 day') g
       LEFT JOIN per_day pd ON pd.work_date = g::date
       LEFT JOIN forms f ON f.day = g::date
       ORDER BY g`,
    );

    const weekdays = await q<{
      weekday: number;
      days: number;
      workedSeconds: number;
    }>(
      `WITH ${DAYS_CTE}
       SELECT extract(isodow FROM work_date)::int AS weekday, count(*)::int AS days,
              round(sum(worked))::int AS "workedSeconds"
       FROM days GROUP BY 1 ORDER BY 1`,
    );
    const startHours = await q<{ hour: number; days: number }>(
      `WITH ${DAYS_CTE}
       SELECT extract(hour FROM started_at AT TIME ZONE $3)::int AS hour, count(*)::int AS days
       FROM days GROUP BY 1 ORDER BY 1`,
    );

    const groups = await q<{
      id: string;
      name: string;
      agents: number;
      activeAgents: number;
      days: number;
      workedSeconds: number;
      forms: number;
      formsRejected: number;
      avgResponseSeconds: number | null;
    }>(
      `WITH ${DAYS_CTE}
       SELECT g.id, g.name,
              (SELECT count(*)::int FROM users u WHERE u.group_id = g.id AND u.role = 'agent' AND u.is_active) AS agents,
              count(DISTINCT d.agent_id)::int AS "activeAgents",
              count(d.id)::int AS days,
              coalesce(round(sum(d.worked)), 0)::int AS "workedSeconds",
              (SELECT count(*)::int FROM mission_submissions s JOIN users u ON u.id = s.agent_id
               WHERE u.group_id = g.id AND s.status = 'accepted' AND ${IN_PERIOD('s.submitted_at')}
                 AND ${AGENT_IN_GROUP('s.agent_id')} AND ${DAY_IN_ZONE('s.day_id')}) AS forms,
              (SELECT count(*)::int FROM mission_submissions s JOIN users u ON u.id = s.agent_id
               WHERE u.group_id = g.id AND s.status = 'rejected' AND ${IN_PERIOD('s.submitted_at')}
                 AND ${AGENT_IN_GROUP('s.agent_id')} AND ${DAY_IN_ZONE('s.day_id')}) AS "formsRejected",
              (SELECT round(avg(extract(epoch FROM r.decided_at - r.created_at)))::int
               FROM zone_requests r JOIN users u ON u.id = r.agent_id
               WHERE u.group_id = g.id AND r.requires_approval AND r.decided_by_id IS NOT NULL
                 AND coalesce(r.decision_reason, '') NOT LIKE 'reassigned%'
                 AND ${IN_PERIOD('r.created_at')} AND ${AGENT_IN_GROUP('r.agent_id')}
                 AND ($6::uuid IS NULL OR r.zone_id = $6)) AS "avgResponseSeconds"
       FROM groups g
       LEFT JOIN users a ON a.group_id = g.id
       LEFT JOIN days d ON d.agent_id = a.id
       WHERE g.is_active AND ($4::uuid IS NULL OR g.id = $4)
       GROUP BY g.id ORDER BY g.name`,
    );

    const zones = await q<{
      id: string;
      name: string;
      capacity: number | null;
      days: number;
      agents: number;
      workedSeconds: number;
      occupancy: number | null;
    }>(
      `WITH ${DAYS_CTE},
       active_dates AS (SELECT count(DISTINCT work_date)::int AS n FROM days)
       SELECT z.id, z.name, z.capacity,
              count(d.id)::int AS days, count(DISTINCT d.agent_id)::int AS agents,
              coalesce(round(sum(d.worked)), 0)::int AS "workedSeconds",
              CASE WHEN z.capacity IS NULL OR (SELECT n FROM active_dates) = 0 THEN NULL
                   ELSE round(count(d.id)::numeric / (z.capacity * (SELECT n FROM active_dates)), 3)::float8
              END AS occupancy
       FROM zones z LEFT JOIN days d ON d.zone_id = z.id
       WHERE z.is_active AND ($6::uuid IS NULL OR z.id = $6)
       GROUP BY z.id ORDER BY count(d.id) DESC, z.name`,
    );

    const agents = await q<{
      id: string;
      firstName: string;
      lastName: string;
      groupName: string | null;
      days: number;
      workedSeconds: number;
      forms: number;
      formsRejected: number;
      distanceKm: number;
      autoClosedDays: number;
    }>(
      `WITH ${DAYS_CTE}, ${DISTANCE_CTE},
       per_agent AS (
         SELECT agent_id, count(*)::int AS days, round(sum(worked))::int AS worked,
                count(*) FILTER (WHERE end_reason = 'auto_reset')::int AS auto_closed
         FROM days GROUP BY agent_id
       ),
       distance AS (SELECT agent_id, sum(meters) AS meters FROM segments WHERE meters < 2000 GROUP BY agent_id),
       forms AS (
         SELECT agent_id, count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
                count(*) FILTER (WHERE status = 'rejected')::int AS rejected
         FROM mission_submissions
         WHERE ${IN_PERIOD('submitted_at')} AND ${DAY_IN_ZONE('day_id')} GROUP BY agent_id
       )
       SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName", g.name AS "groupName",
              pa.days, pa.worked AS "workedSeconds",
              coalesce(f.accepted, 0) AS forms, coalesce(f.rejected, 0) AS "formsRejected",
              round((coalesce(di.meters, 0) / 1000.0)::numeric, 1)::float8 AS "distanceKm",
              pa.auto_closed AS "autoClosedDays"
       FROM per_agent pa
       JOIN users u ON u.id = pa.agent_id
       LEFT JOIN groups g ON g.id = u.group_id
       LEFT JOIN distance di ON di.agent_id = pa.agent_id
       LEFT JOIN forms f ON f.agent_id = pa.agent_id
       ORDER BY pa.worked DESC`,
    );

    const [missionCounts] = await q<{
      open: number;
      achieved: number;
      failed: number;
    }>(
      `SELECT count(*) FILTER (WHERE status IN ('todo', 'in_progress'))::int AS open,
              count(*) FILTER (WHERE status = 'achieved' AND ${IN_PERIOD('updated_at')})::int AS achieved,
              count(*) FILTER (WHERE status = 'failed' AND ${IN_PERIOD('updated_at')})::int AS failed
       FROM missions
       WHERE is_active AND ($4::uuid IS NULL OR assignee_group_id = $4
             OR assignee_agent_id IN (SELECT id FROM users WHERE group_id = $4))`,
      params.slice(0, 4),
    );
    const open = (
      await this.missions.list(
        user,
        Object.assign(new ListMissionsQuery(), {
          limit: 100,
          groupId: query.groupId,
          agentId: query.agentId,
        }),
      )
    ).items
      .filter(
        (m) =>
          m.status === MissionStatus.Todo ||
          m.status === MissionStatus.InProgress,
      )
      .sort(
        (a, b) =>
          (a.dueDate?.getTime() ?? Infinity) -
          (b.dueDate?.getTime() ?? Infinity),
      )
      .slice(0, 8)
      .map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        dueDate: m.dueDate,
        progress: m.progress,
      }));

    return {
      from,
      to,
      previous,
      kpis: { ...kpis, ...details, requests, missions: missionCounts },
      previousKpis,
      daily,
      weekdays,
      startHours,
      groups,
      zones,
      agents,
      openMissions: open,
    };
  }

  /** Indicateurs comparables d'une période à l'autre. */
  private async kpis(params: unknown[]): Promise<Kpis> {
    const [row] = await this.db.manager.query<Kpis[]>(
      `WITH ${DAYS_CTE}, ${DISTANCE_CTE}
       SELECT
         (SELECT count(DISTINCT agent_id)::int FROM days) AS "activeAgents",
         (SELECT count(*)::int FROM days) AS days,
         (SELECT coalesce(round(sum(worked)), 0)::int FROM days) AS "workedSeconds",
         (SELECT count(*)::int FROM mission_submissions
          WHERE status = 'accepted' AND ${IN_PERIOD('submitted_at')} AND ${AGENT_IN_GROUP('agent_id')}
            AND ${DAY_IN_ZONE('day_id')}) AS forms,
         (SELECT count(*)::int FROM mission_submissions
          WHERE status = 'rejected' AND ${IN_PERIOD('submitted_at')} AND ${AGENT_IN_GROUP('agent_id')}
            AND ${DAY_IN_ZONE('day_id')}) AS "formsRejected",
         (SELECT round((coalesce(sum(meters), 0) / 1000.0)::numeric, 1)::float8 FROM segments WHERE meters < 2000) AS "distanceKm"`,
      params,
    );
    return row;
  }
}
