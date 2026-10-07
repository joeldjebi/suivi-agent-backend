import { Injectable } from '@nestjs/common';
import { Role } from '@suivi/shared';
import { In } from 'typeorm';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { DbService } from '../common/db.service';
import { workDate } from '../common/time.util';
import { workedDaysCte } from '../common/worked-days.sql';
import { Group, User, Zone } from '../entities';
import { ZonesService } from '../zones/zones.service';

export interface TeamLeadInfo {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
}

/**
 * Ce que l'agent sait de son équipe : son groupe, son ou ses chefs (à appeler) et les
 * zones qu'il peut choisir. Sans groupes, les chefs suivent toute la structure.
 */
@Injectable()
export class MeService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly zones: ZonesService,
  ) {}

  async team(user: AuthUser) {
    const m = this.db.manager;
    const settings = await this.access.settings();
    const agent = await this.access.getAgent(user.id);
    const group =
      settings.useGroups && agent.groupId
        ? await m.findOneBy(Group, { id: agent.groupId, isActive: true })
        : null;

    let leads: User[] = [];
    if (settings.useGroups) {
      if (group?.leaderId)
        leads = await m.findBy(User, {
          id: group.leaderId,
          isActive: true,
        });
    } else {
      leads = await m.find(User, {
        where: { role: Role.TeamLead, isActive: true },
        order: { firstName: 'ASC' },
      });
    }

    const zoneIds = await this.zones.accessibleZoneIds(agent, settings);
    const zones = zoneIds.length
      ? await m.find(Zone, {
          where: { id: In(zoneIds) },
          order: { name: 'ASC' },
        })
      : [];
    const [{ members }] = group
      ? await m.query<{ members: number }[]>(
          `SELECT count(*)::int AS members FROM users WHERE group_id = $1 AND role = 'agent' AND is_active`,
          [group.id],
        )
      : [{ members: 0 }];

    return {
      usesGroups: settings.useGroups,
      group: group ? { id: group.id, name: group.name, members } : null,
      /** Rattaché à aucun groupe alors que la structure en utilise : aucune zone possible. */
      groupMissing: settings.useGroups && !group,
      leads: leads.map((l): TeamLeadInfo => ({
        id: l.id,
        firstName: l.firstName,
        lastName: l.lastName,
        phone: l.phone,
      })),
      zones: zones.map((z) => ({
        id: z.id,
        name: z.name,
        capacity: z.capacity,
      })),
    };
  }

  /**
   * « Ma semaine » : de lundi à dimanche, le temps travaillé par jour (pauses déduites) face
   * à l'objectif, les zones, les formulaires envoyés et rejetés, les missions où l'agent a
   * contribué ; et la semaine précédente pour comparer.
   */
  async week(user: AuthUser, date?: string) {
    const m = this.db.manager;
    const settings = await this.access.settings();
    const today = workDate(
      new Date(),
      settings.timezone,
      settings.dailyResetTime,
    );
    const [{ from, to, previousFrom }] = await m.query<
      { from: string; to: string; previousFrom: string }[]
    >(
      `SELECT to_char(date_trunc('week', $1::date), 'YYYY-MM-DD') AS "from",
              to_char(date_trunc('week', $1::date) + interval '6 days', 'YYYY-MM-DD') AS "to",
              to_char(date_trunc('week', $1::date) - interval '7 days', 'YYYY-MM-DD') AS "previousFrom"`,
      [date ?? today],
    );
    const worked = await m.query<
      { date: string; seconds: number; zones: string[] }[]
    >(
      `WITH ${workedDaysCte('d.agent_id = $1 AND d.work_date BETWEEN $2::date AND $3::date')}
       SELECT to_char(days.work_date, 'YYYY-MM-DD') AS date,
              round(sum(days.worked))::int AS seconds,
              coalesce(array_agg(DISTINCT z.name) FILTER (WHERE z.name IS NOT NULL), '{}') AS zones
       FROM days LEFT JOIN zones z ON z.id = days.zone_id
       GROUP BY days.work_date`,
      [user.id, previousFrom, to],
    );
    const forms = await m.query<
      { date: string; sent: number; rejected: number }[]
    >(
      `SELECT to_char((submitted_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS date,
              count(*)::int AS sent,
              count(*) FILTER (WHERE status = 'rejected')::int AS rejected
       FROM mission_submissions
       WHERE agent_id = $1
         AND (submitted_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
       GROUP BY 1`,
      [user.id, previousFrom, to, settings.timezone],
    );
    const missions = await m.query<
      { id: string; title: string; forms: number }[]
    >(
      `SELECT mi.id, mi.title, count(*)::int AS forms
       FROM mission_submissions s JOIN missions mi ON mi.id = s.mission_id
       WHERE s.agent_id = $1 AND s.status = 'accepted'
         AND (s.submitted_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
       GROUP BY mi.id, mi.title ORDER BY forms DESC, mi.title LIMIT 5`,
      [user.id, from, to, settings.timezone],
    );
    const objectiveMinutes =
      (await this.access.workdays([user.id])).get(user.id)?.minutes ?? 480;

    const byDate = new Map(worked.map((w) => [w.date, w]));
    const formsByDate = new Map(forms.map((f) => [f.date, f]));
    const dates = (start: string) =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(`${start}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        return d.toISOString().slice(0, 10);
      });
    const days = dates(from).map((d) => ({
      date: d,
      workedSeconds: byDate.get(d)?.seconds ?? 0,
      zones: byDate.get(d)?.zones ?? [],
      forms: formsByDate.get(d)?.sent ?? 0,
      rejected: formsByDate.get(d)?.rejected ?? 0,
      future: d > today,
    }));
    const sum = (list: string[]) => ({
      workedSeconds: list.reduce(
        (t, d) => t + (byDate.get(d)?.seconds ?? 0),
        0,
      ),
      daysWorked: list.filter((d) => (byDate.get(d)?.seconds ?? 0) > 0).length,
      forms: list.reduce((t, d) => t + (formsByDate.get(d)?.sent ?? 0), 0),
      rejected: list.reduce(
        (t, d) => t + (formsByDate.get(d)?.rejected ?? 0),
        0,
      ),
    });
    const totals = sum(dates(from));
    return {
      from,
      to,
      today,
      objectiveMinutes,
      days,
      totals: {
        ...totals,
        // Objectif des jours travaillés : un jour sans travail ne compte pas contre l'agent.
        objectiveSeconds: totals.daysWorked * objectiveMinutes * 60,
      },
      previous: sum(dates(previousFrom)),
      missions,
    };
  }
}
