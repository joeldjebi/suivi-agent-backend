import { Injectable } from '@nestjs/common';
import { FieldType, type MissionField, Role } from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { workDate } from '../common/time.util';
import { MissionType } from '../entities';
import type { FormStatsQuery } from './insights.dto';

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Formulaires reçus au plus, par calcul (au-delà : période à réduire). */
const MAX_SUBMISSIONS = 20_000;

/** Chiffres d'un champ, selon son type. */
export type FieldStats =
  | {
      kind: 'number';
      answered: number;
      sum: number;
      avg: number | null;
      min: number | null;
      max: number | null;
    }
  | {
      kind: 'boolean';
      answered: number;
      yes: number;
      no: number;
      yesRate: number | null;
    }
  | {
      kind: 'select';
      answered: number;
      options: { value: string; count: number }[];
    }
  | { kind: 'photo'; answered: number }
  | { kind: 'products'; answered: number; products: Record<string, unknown>[] }
  | { kind: 'text'; answered: number };

const answered = (v: unknown) =>
  v !== undefined &&
  v !== null &&
  v !== '' &&
  !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Statistiques des formulaires créés par la structure : pour chaque formulaire rempli sur la
 * période (visites et missions), chaque champ résumé selon son type — total et moyenne d'un
 * nombre, part de « Oui », répartition d'une liste de choix, photos prises, relevé produit par
 * produit. Formulaires acceptés seulement ; l'agent voit les siens, le chef ceux de son
 * équipe, l'administrateur tous.
 */
@Injectable()
export class FormStatsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  /** $1 début, $2 fin (dates de la structure), $3 fuseau, $4 agents (null : tous). */
  private async scope(user: AuthUser, q: FormStatsQuery) {
    const settings = await this.access.settings();
    const today = workDate(
      new Date(),
      settings.timezone,
      settings.dailyResetTime,
    );
    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -29);
    if (from > to)
      throw badRequest(
        'INVALID_PERIOD',
        'La fin de la période précède son début',
      );
    const agents =
      user.role === Role.Admin ? null : await this.access.agentScope(user);
    return { from, to, params: [from, to, settings.timezone, agents] };
  }

  private readonly WHERE = `s.status = 'accepted'
    AND s.submitted_at >= ($1::date)::timestamp AT TIME ZONE $3
    AND s.submitted_at < ($2::date + 1)::timestamp AT TIME ZONE $3
    AND ($4::uuid[] IS NULL OR s.agent_id = ANY($4::uuid[]))`;

  /** Formulaires remplis sur la période, les plus utilisés d'abord. */
  async forms(user: AuthUser, q: FormStatsQuery) {
    const { from, to, params } = await this.scope(user, q);
    const forms = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT t.id, t.name, count(*)::int AS submissions,
              count(DISTINCT s.outlet_id)::int AS outlets, max(s.submitted_at) AS "lastAt"
       FROM mission_submissions s JOIN mission_types t ON t.id = s.type_id
       WHERE ${this.WHERE}
       GROUP BY t.id, t.name ORDER BY submissions DESC, t.name`,
      params,
    );
    return { from, to, forms };
  }

  /** Un formulaire : chaque champ résumé selon son type. */
  async form(user: AuthUser, typeId: string, q: FormStatsQuery) {
    const type = await this.db.manager.findOneBy(MissionType, { id: typeId });
    if (!type) throw notFound('Formulaire');
    const { from, to, params } = await this.scope(user, q);
    const rows = await this.db.manager.query<
      { id: string; data: Record<string, unknown>; outletId: string | null }[]
    >(
      `SELECT s.id, s.data, s.outlet_id AS "outletId"
       FROM mission_submissions s
       WHERE s.type_id = $5 AND ${this.WHERE}
       ORDER BY s.submitted_at DESC LIMIT ${MAX_SUBMISSIONS + 1}`,
      [...params, typeId],
    );
    if (rows.length > MAX_SUBMISSIONS)
      throw badRequest(
        'PERIOD_TOO_LONG',
        'Trop de formulaires sur cette période : choisissez une période plus courte',
      );
    const fields = await Promise.all(
      type.fields.map(async (f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        stats: await this.fieldStats(f, rows, params, typeId),
      })),
    );
    return {
      from,
      to,
      form: { id: type.id, name: type.name },
      submissions: rows.length,
      outlets: new Set(rows.map((r) => r.outletId).filter(Boolean)).size,
      fields,
    };
  }

  private async fieldStats(
    f: MissionField,
    rows: { data: Record<string, unknown> }[],
    params: unknown[],
    typeId: string,
  ): Promise<FieldStats> {
    const values = rows.map((r) => r.data?.[f.key]).filter(answered);
    switch (f.type) {
      case FieldType.Number: {
        const nums = values.map(Number).filter((n) => Number.isFinite(n));
        const sum = nums.reduce((a, b) => a + b, 0);
        return {
          kind: 'number',
          answered: nums.length,
          sum: round(sum),
          avg: nums.length ? round(sum / nums.length) : null,
          min: nums.length ? Math.min(...nums) : null,
          max: nums.length ? Math.max(...nums) : null,
        };
      }
      case FieldType.Boolean: {
        const yes = values.filter((v) => v === true).length;
        const no = values.filter((v) => v === false).length;
        return {
          kind: 'boolean',
          answered: yes + no,
          yes,
          no,
          yesRate: yes + no ? Math.round((yes / (yes + no)) * 100) : null,
        };
      }
      case FieldType.Select: {
        const counts = new Map<string, number>(
          (f.options ?? []).map((o) => [o, 0]),
        );
        for (const v of values)
          counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
        return {
          kind: 'select',
          answered: values.length,
          options: [...counts]
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count),
        };
      }
      case FieldType.Photo:
        return { kind: 'photo', answered: values.length };
      case FieldType.Products: {
        // Relevé par produit : présence, ruptures, stock, prix et ventes de chaque produit.
        const products = await this.db.manager.query<Record<string, unknown>[]>(
          `SELECT pr.product_id AS "productId", p.name, p.format, p.own, p.unit, p.packagings,
                  count(*)::int AS readings,
                  count(*) FILTER (WHERE pr.presence IS NOT NULL)::int AS checked,
                  count(*) FILTER (WHERE pr.presence = false)::int AS stockouts,
                  round(avg(pr.stock))::float8 AS "avgStock",
                  round(avg(pr.price))::float8 AS "avgPrice",
                  coalesce(sum(pr.sold), 0)::float8 AS sold,
                  coalesce(sum(pr.losses), 0)::float8 AS losses
           FROM product_readings pr
           JOIN mission_submissions s ON s.id = pr.submission_id
           JOIN products p ON p.id = pr.product_id
           WHERE s.type_id = $5 AND pr.field_key = $6 AND ${this.WHERE}
           GROUP BY pr.product_id, p.name, p.format, p.own, p.unit, p.packagings
           ORDER BY p.own DESC, sold DESC, p.name`,
          [...params, typeId, f.key],
        );
        return { kind: 'products', answered: values.length, products };
      }
      default:
        return { kind: 'text', answered: values.length };
    }
  }
}
