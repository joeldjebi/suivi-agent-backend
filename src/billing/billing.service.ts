import { Injectable } from '@nestjs/common';
import { AccessService } from '../common/access.service';
import { DbService } from '../common/db.service';
import { workDate } from '../common/time.util';
import { workedDaysCte } from '../common/worked-days.sql';
import type { BillingAgent, BillingQuery } from './billing.dto';

/** Mois précédent, au format AAAA-MM. */
export function previousMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return m === 1
    ? `${year - 1}-12`
    : `${year}-${String(m - 1).padStart(2, '0')}`;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  /** Agents actifs du mois : ceux qui ont démarré au moins une journée (RG-40 à RG-42). */
  async activeAgents(query: BillingQuery) {
    const settings = await this.access.settings();
    const month =
      query.month ??
      workDate(new Date(), settings.timezone, settings.dailyResetTime).slice(
        0,
        7,
      );
    const previous = previousMonth(month);
    const digits = query.search?.replace(/\D/g, '') ?? '';

    const agents = await this.db.manager.query<BillingAgent[]>(
      `WITH ${workedDaysCte(
        `d.work_date >= $1::date AND d.work_date < $1::date + interval '1 month'`,
      )},
       per_agent AS (
         SELECT agent_id,
                count(*)::int AS days,
                round(sum(worked))::int AS worked_seconds,
                min(work_date) AS first_day,
                max(work_date) AS last_day,
                count(DISTINCT zone_id)::int AS zones,
                count(*) FILTER (WHERE end_reason = 'auto_reset')::int AS auto_closed
         FROM days GROUP BY agent_id
       ),
       main_zone AS (
         SELECT DISTINCT ON (agent_id) agent_id, zone_id
         FROM days WHERE zone_id IS NOT NULL
         GROUP BY agent_id, zone_id
         ORDER BY agent_id, count(*) DESC, zone_id
       ),
       forms AS (
         SELECT agent_id,
                count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
                count(*) FILTER (WHERE status = 'rejected')::int AS rejected
         FROM mission_submissions
         WHERE (submitted_at AT TIME ZONE $2) >= $1::date
           AND (submitted_at AT TIME ZONE $2) < $1::date + interval '1 month'
         GROUP BY agent_id
       )
       SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName",
              u.phone, u.email, u.is_active AS "isActive",
              u.group_id AS "groupId", g.name AS "groupName",
              pa.days, pa.worked_seconds AS "workedSeconds",
              to_char(pa.first_day, 'YYYY-MM-DD') AS "firstDay",
              to_char(pa.last_day, 'YYYY-MM-DD') AS "lastDay",
              z.name AS "mainZone", pa.zones,
              coalesce(f.accepted, 0) AS forms,
              coalesce(f.rejected, 0) AS "rejectedForms",
              pa.auto_closed AS "autoClosedDays"
       FROM per_agent pa
       JOIN users u ON u.id = pa.agent_id
       LEFT JOIN groups g ON g.id = u.group_id
       LEFT JOIN main_zone mz ON mz.agent_id = pa.agent_id
       LEFT JOIN zones z ON z.id = mz.zone_id
       LEFT JOIN forms f ON f.agent_id = pa.agent_id
       WHERE ($3::uuid IS NULL OR u.group_id = $3)
         AND ($4::uuid IS NULL OR EXISTS (
               SELECT 1 FROM days dz WHERE dz.agent_id = pa.agent_id AND dz.zone_id = $4))
         AND ($5::text IS NULL
              OR lower(u.first_name || ' ' || u.last_name) LIKE '%' || lower($5) || '%'
              OR lower(u.last_name || ' ' || u.first_name) LIKE '%' || lower($5) || '%'
              OR lower(u.email) LIKE '%' || lower($5) || '%'
              OR ($6 <> '' AND u.phone LIKE '%' || $6 || '%'))
         AND ($7::text IS NULL OR u.is_active = ($7 = 'active'))
         AND pa.days >= $8
       ORDER BY u.last_name, u.first_name`,
      [
        `${month}-01`,
        settings.timezone,
        query.groupId ?? null,
        query.zoneId ?? null,
        query.search?.trim() || null,
        digits.length >= 3 ? digits : '',
        query.account ?? null,
        query.minDays ?? 1,
      ],
    );

    // Le total facturé ne dépend pas des filtres.
    const [counts] = await this.db.manager.query<
      { current: number; previous: number }[]
    >(
      `SELECT
         count(DISTINCT agent_id) FILTER (
           WHERE work_date >= $1::date AND work_date < $1::date + interval '1 month')::int AS current,
         count(DISTINCT agent_id) FILTER (
           WHERE work_date >= $2::date AND work_date < $2::date + interval '1 month')::int AS previous
       FROM work_days
       WHERE work_date >= $2::date AND work_date < $1::date + interval '1 month'`,
      [`${month}-01`, `${previous}-01`],
    );

    const days = agents.reduce((sum, a) => sum + a.days, 0);
    const workedSeconds = agents.reduce((sum, a) => sum + a.workedSeconds, 0);
    return {
      month,
      activeAgents: counts.current,
      previous: { month: previous, activeAgents: counts.previous },
      /** Totaux des agents affichés (après filtres) */
      shown: {
        agents: agents.length,
        days,
        workedSeconds,
        forms: agents.reduce((sum, a) => sum + a.forms, 0),
      },
      agents,
    };
  }
}
