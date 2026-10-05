import { Injectable } from '@nestjs/common';
import type {
  MissionPay,
  PayGridComponents,
  PayGridTargets,
} from '@suivi/shared';
import { DbService } from '../common/db.service';
import { workedDaysCte } from '../common/worked-days.sql';
import type { PayGrid } from '../entities';
import type { PayItem } from '../entities/payroll.entity';
import type { Period } from './period';

/** Personne rémunérée : agent ou chef d'équipe. */
export interface Payee {
  id: string;
  firstName: string;
  lastName: string;
  role: 'agent' | 'team_lead';
  groupId: string | null;
  phone: string | null;
  /** Groupes dont la personne est cheffe */
  ledGroups: string[];
}

export interface ComputedLine {
  payee: Payee;
  grid: PayGrid | null;
  items: PayItem[];
  gross: number;
}

interface DayRow {
  agentId: string;
  worked: number;
  autoClosed: boolean;
  mocked: boolean;
  outside: number;
}

interface FormRow {
  agentId: string;
  missionId: string;
  missionTitle: string;
  /** Rémunération de la mission, sinon de son type (remplace la grille) */
  pay: MissionPay | null;
  typeId: string;
  typeName: string;
  accepted: number;
  rejected: number;
  amount: number;
}

interface MissionRow {
  id: string;
  title: string;
  agentId: string | null;
  groupId: string | null;
  percent: number;
  contributors: string[];
  pay: MissionPay | null;
}

/** Part maximale de positions hors zone pour qu'une journée compte « dans la zone ». */
const IN_ZONE_RATIO = 0.2;

/**
 * Calcul automatique de la rémunération d'une période, à partir des journées, formulaires
 * et missions déjà enregistrés. Aucune saisie : tout vient de l'activité réelle.
 */
@Injectable()
export class PayrollCalculator {
  constructor(private readonly db: DbService) {}

  /** Grille d'une personne : agent > groupe > rôle ; la plus récente en cas d'égalité. */
  static gridFor(payee: Payee, grids: PayGrid[]): PayGrid | null {
    const active = grids.filter((g) => g.isActive);
    const match = (pick: (t: PayGridTargets) => boolean) =>
      active.find((g) => pick(g.targets ?? {})) ?? null;
    return (
      match((t) => !!t.userIds?.includes(payee.id)) ??
      (payee.groupId
        ? match((t) => !!t.groupIds?.includes(payee.groupId!))
        : null) ??
      match((t) => !!t.roles?.includes(payee.role))
    );
  }

  async compute(
    period: Period,
    timezone: string,
    grids: PayGrid[],
    onlyUserIds: string[] | null = null,
  ): Promise<ComputedLine[]> {
    const m = this.db.manager;
    const range = [period.start, period.end];

    const payees = await m.query<Payee[]>(
      `SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName", u.role,
              u.group_id AS "groupId", u.phone,
              ARRAY(SELECT g.id::text FROM groups g WHERE g.leader_id = u.id AND g.is_active) AS "ledGroups"
       FROM users u
       WHERE u.role IN ('agent', 'team_lead')
         AND (u.is_active OR EXISTS (
               SELECT 1 FROM work_days d WHERE d.agent_id = u.id AND d.work_date BETWEEN $1::date AND $2::date))
         AND ($3::uuid[] IS NULL OR u.id = ANY($3::uuid[]))
       ORDER BY u.last_name, u.first_name`,
      [...range, onlyUserIds],
    );
    if (!payees.length) return [];

    const days = await m.query<DayRow[]>(
      `WITH ${workedDaysCte(`d.work_date BETWEEN $1::date AND $2::date`)}
       SELECT d.agent_id AS "agentId", d.worked::float8 AS worked,
              d.end_reason = 'auto_reset' AS "autoClosed",
              EXISTS (SELECT 1 FROM positions p WHERE p.day_id = d.id AND p.is_mocked) AS mocked,
              coalesce((SELECT count(*) FILTER (WHERE p.outside_zone)::float8 / nullif(count(*), 0)
                        FROM positions p WHERE p.day_id = d.id), 0) AS outside
       FROM days d`,
      range,
    );
    const forms = await m.query<FormRow[]>(
      `SELECT s.agent_id AS "agentId", m.id AS "missionId", m.title AS "missionTitle",
              coalesce(m.pay, t.pay) AS pay,
              m.type_id AS "typeId", t.name AS "typeName",
              count(*) FILTER (WHERE s.status = 'accepted')::int AS accepted,
              count(*) FILTER (WHERE s.status = 'rejected')::int AS rejected,
              coalesce(sum(CASE WHEN s.status = 'accepted' AND m.progress_method = 'field_sum'
                                 AND (s.data ->> m.sum_field_key) ~ '^-?[0-9]+(\\.[0-9]+)?$'
                            THEN (s.data ->> m.sum_field_key)::numeric END), 0)::float8 AS amount
       FROM mission_submissions s
       JOIN missions m ON m.id = s.mission_id
       JOIN mission_types t ON t.id = m.type_id
       WHERE (s.submitted_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
       GROUP BY s.agent_id, m.id, t.id`,
      [...range, timezone],
    );
    // Missions arrivées à échéance sur la période (ou atteintes, si sans échéance).
    const missions = await m.query<MissionRow[]>(
      `SELECT m.id, m.title, m.assignee_agent_id AS "agentId", m.assignee_group_id AS "groupId",
              coalesce(m.pay, (SELECT mt.pay FROM mission_types mt WHERE mt.id = m.type_id)) AS pay,
              CASE
                WHEN m.progress_method = 'manual' THEN CASE WHEN m.status = 'achieved' THEN 100 ELSE 0 END
                WHEN m.progress_method = 'count' THEN
                  (SELECT count(*) FROM mission_submissions s WHERE s.mission_id = m.id AND s.status = 'accepted')
                  * 100.0 / nullif(m.target_value, 0)
                ELSE
                  (SELECT coalesce(sum(CASE WHEN (s.data ->> m.sum_field_key) ~ '^-?[0-9]+(\\.[0-9]+)?$'
                                            THEN (s.data ->> m.sum_field_key)::numeric END), 0)
                   FROM mission_submissions s WHERE s.mission_id = m.id AND s.status = 'accepted')
                  * 100.0 / nullif(m.target_value, 0)
              END::float8 AS percent,
              ARRAY(SELECT DISTINCT s.agent_id::text FROM mission_submissions s
                    WHERE s.mission_id = m.id AND s.status = 'accepted') AS contributors
       FROM missions m
       WHERE m.is_active
         AND ((m.due_date AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
              OR (m.due_date IS NULL AND m.status = 'achieved'
                  AND (m.updated_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date))`,
      [...range, timezone],
    );

    // Équipe de chaque chef : agents de ses groupes (y compris ceux hors du calcul demandé).
    const teamOf = new Map<string, string[]>();
    const leads = payees.filter((p) => p.role === 'team_lead');
    if (leads.length) {
      const team = await m.query<{ leaderId: string; agentId: string }[]>(
        `SELECT g.leader_id AS "leaderId", u.id AS "agentId"
         FROM groups g JOIN users u ON u.group_id = g.id AND u.role = 'agent'
         WHERE g.leader_id = ANY($1::uuid[]) AND g.is_active`,
        [leads.map((l) => l.id)],
      );
      for (const row of team)
        teamOf.set(row.leaderId, [
          ...(teamOf.get(row.leaderId) ?? []),
          row.agentId,
        ]);
    }

    return payees.map((payee) => {
      const grid = PayrollCalculator.gridFor(payee, grids);
      // Sans grille, seules les missions à rémunération propre rapportent.
      const items = this.items(payee, grid?.components ?? {}, {
        days: days.filter((d) => d.agentId === payee.id),
        forms: forms.filter((f) => f.agentId === payee.id),
        missions,
        team: teamOf.get(payee.id) ?? [],
        teamDays: days,
        teamForms: forms,
      });
      return {
        payee,
        grid,
        items,
        gross: Math.max(
          0,
          items.reduce((s, i) => s + i.amount, 0),
        ),
      };
    });
  }

  private items(
    payee: Payee,
    c: PayGridComponents,
    data: {
      days: DayRow[];
      forms: FormRow[];
      missions: MissionRow[];
      team: string[];
      teamDays: DayRow[];
      teamForms: FormRow[];
    },
  ): PayItem[] {
    const items: PayItem[] = [];
    const add = (
      code: string,
      label: string,
      quantity: number | null,
      unitAmount: number | null,
      amount: number,
    ) => {
      if (amount !== 0 || (quantity ?? 0) > 0)
        items.push({
          code,
          label,
          quantity,
          unitAmount,
          amount: Math.round(amount),
        });
    };
    const validDay = (d: DayRow) =>
      !d.mocked &&
      (!c.perDay?.minHours || d.worked >= c.perDay.minHours * 3600) &&
      (!c.perDay?.requireInZone || d.outside <= IN_ZONE_RATIO);

    if (c.fixed) add('fixed', 'Fixe', null, null, c.fixed);

    if (c.perDay?.amount) {
      const n = data.days.filter(validDay).length;
      add('days', 'Journées validées', n, c.perDay.amount, n * c.perDay.amount);
    }

    // Formulaires des missions sans rémunération propre ni de type : grille de l’agent.
    const gridForms = data.forms.filter((f) => !f.pay);
    const ownForms = data.forms.filter((f) => f.pay);

    if (c.perForm) {
      const byType = new Map<string, { name: string; accepted: number }>();
      for (const f of gridForms) {
        const t = byType.get(f.typeId) ?? { name: f.typeName, accepted: 0 };
        t.accepted += f.accepted;
        byType.set(f.typeId, t);
      }
      for (const [typeId, t] of byType) {
        const unit = c.perForm.byType?.[typeId] ?? c.perForm.amount;
        if (unit && t.accepted > 0)
          add(
            `forms:${typeId}`,
            `Formulaires « ${t.name} »`,
            t.accepted,
            unit,
            t.accepted * unit,
          );
      }
    }

    if (c.commission?.percent) {
      const base = gridForms.reduce((s, f) => s + f.amount, 0);
      if (base > 0)
        add(
          'commission',
          `Commission ${c.commission.percent} % sur ${Math.round(base).toLocaleString('fr-FR')}`,
          null,
          null,
          (base * c.commission.percent) / 100,
        );
    }

    // Missions à rémunération propre (ou celle de leur type) : elle remplace la grille.
    for (const f of ownForms) {
      const pay = f.pay!;
      if (pay.perForm && f.accepted > 0)
        add(
          `mission_forms:${f.missionId}`,
          `Formulaires « ${f.missionTitle} »`,
          f.accepted,
          pay.perForm,
          f.accepted * pay.perForm,
        );
      if (pay.commissionPercent && f.amount > 0)
        add(
          `mission_commission:${f.missionId}`,
          `Commission ${pay.commissionPercent} % « ${f.missionTitle} » sur ${Math.round(f.amount).toLocaleString('fr-FR')}`,
          null,
          null,
          (f.amount * pay.commissionPercent) / 100,
        );
    }

    const gridTiers = [...(c.objectiveBonus ?? [])].sort(
      (a, b) => b.thresholdPercent - a.thresholdPercent,
    );
    for (const mission of data.missions) {
      const concerned =
        mission.agentId === payee.id ||
        (!!mission.groupId && mission.contributors.includes(payee.id));
      if (!concerned) continue;
      // Paliers de la mission s'ils sont propres (même vides), sinon ceux de la grille.
      const tiers = mission.pay
        ? [...(mission.pay.objectiveBonus ?? [])].sort(
            (a, b) => b.thresholdPercent - a.thresholdPercent,
          )
        : gridTiers;
      const tier = tiers.find((t) => mission.percent >= t.thresholdPercent);
      if (tier)
        add(
          `objective:${mission.id}`,
          `Objectif « ${mission.title} » (${Math.floor(mission.percent)} %)`,
          null,
          null,
          tier.amount,
        );
    }

    if (payee.role === 'team_lead' && data.team.length) {
      const team = new Set(data.team);
      const byMission = new Map<string, { f: FormRow; accepted: number }>();
      for (const f of data.teamForms) {
        if (!f.pay?.leadPerTeamForm || !team.has(f.agentId)) continue;
        const entry = byMission.get(f.missionId) ?? { f, accepted: 0 };
        entry.accepted += f.accepted;
        byMission.set(f.missionId, entry);
      }
      for (const { f, accepted } of byMission.values()) {
        const unit = f.pay!.leadPerTeamForm!;
        if (accepted > 0)
          add(
            `team_mission_forms:${f.missionId}`,
            `Formulaires de l’équipe « ${f.missionTitle} »`,
            accepted,
            unit,
            accepted * unit,
          );
      }
    }

    if (payee.role === 'team_lead' && c.teamBonus && data.team.length) {
      const team = new Set(data.team);
      if (c.teamBonus.perTeamDay) {
        const n = data.teamDays.filter(
          (d) => team.has(d.agentId) && !d.mocked,
        ).length;
        add(
          'team_days',
          'Journées de l’équipe',
          n,
          c.teamBonus.perTeamDay,
          n * c.teamBonus.perTeamDay,
        );
      }
      if (c.teamBonus.perTeamForm) {
        const n = data.teamForms
          .filter((f) => team.has(f.agentId) && !f.pay)
          .reduce((s, f) => s + f.accepted, 0);
        add(
          'team_forms',
          'Formulaires de l’équipe',
          n,
          c.teamBonus.perTeamForm,
          n * c.teamBonus.perTeamForm,
        );
      }
    }

    const d = c.deductions;
    if (d?.perAutoClosedDay) {
      const n = data.days.filter((x) => x.autoClosed).length;
      if (n)
        add(
          'ded_auto_closed',
          'Journées non clôturées',
          n,
          -d.perAutoClosedDay,
          -n * d.perAutoClosedDay,
        );
    }
    if (d?.perRejectedForm) {
      const n = data.forms.reduce((s, f) => s + f.rejected, 0);
      if (n)
        add(
          'ded_rejected',
          'Formulaires rejetés',
          n,
          -d.perRejectedForm,
          -n * d.perRejectedForm,
        );
    }
    if (d?.perMockedDay) {
      const n = data.days.filter((x) => x.mocked).length;
      if (n)
        add(
          'ded_mocked',
          'Journées avec position simulée',
          n,
          -d.perMockedDay,
          -n * d.perMockedDay,
        );
    }

    const total = items.reduce((s, i) => s + i.amount, 0);
    if (c.cap && total > c.cap)
      add(
        'cap',
        `Plafond de ${c.cap.toLocaleString('fr-FR')}`,
        null,
        null,
        c.cap - total,
      );
    return items;
  }
}
