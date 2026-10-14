import { Injectable } from '@nestjs/common';
import { Role } from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { workDate } from '../common/time.util';
import type { InsightsQuery } from './insights.dto';

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Paramètres et conditions communs : $1 début, $2 fin, $3 fuseau, puis les filtres. */
interface Scope {
  params: unknown[];
  from: string;
  to: string;
}

/**
 * Relevés retenus : formulaires acceptés de la période, produits et points de vente filtrés,
 * agents du chef seulement. Les colonnes du produit et du point de vente sont jointes.
 */
const READINGS = `readings AS (
  SELECT pr.*, p.name AS product_name, p.format, p.own, p.category, p.unit, p.packagings,
         o.name AS outlet_name, o.location,
         (SELECT z.name FROM zones z WHERE z.is_active AND o.location IS NOT NULL
            AND ST_Covers(z.area, o.location) ORDER BY z.name LIMIT 1) AS zone_name
  FROM product_readings pr
  JOIN mission_submissions s ON s.id = pr.submission_id AND s.status = 'accepted'
  JOIN products p ON p.id = pr.product_id
  LEFT JOIN outlets o ON o.id = pr.outlet_id
  WHERE pr.submitted_at >= ($1::date)::timestamp AT TIME ZONE $3
    AND pr.submitted_at < ($2::date + 1)::timestamp AT TIME ZONE $3
    AND ($4::uuid[] IS NULL OR pr.agent_id = ANY($4::uuid[]))
    AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM zones z WHERE z.id = $5 AND ST_Covers(z.area, o.location)))
    AND ($6::text IS NULL OR p.category = $6)
    AND ($7::text IS NULL OR p.own = ($7 = 'own'))
    AND ($8::uuid IS NULL OR p.id = $8)
)`;

/** Dernier relevé de présence de chaque produit dans chaque point de vente. */
const LATEST_PRESENCE = `latest AS (
  SELECT DISTINCT ON (outlet_id, product_id) *
  FROM readings WHERE presence IS NOT NULL AND outlet_id IS NOT NULL
  ORDER BY outlet_id, product_id, submitted_at DESC
)`;

/**
 * Tableaux de bord des relevés produits : ruptures en cours, ventes, pertes, prix face à la
 * concurrence, et suivi produit par produit d'un point de vente.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async scope(user: AuthUser, q: InsightsQuery): Promise<Scope> {
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
    // Chef : les relevés de ses agents seulement.
    const agents =
      user.role === Role.Admin ? null : await this.access.agentScope(user);
    return {
      from,
      to,
      params: [
        from,
        to,
        settings.timezone,
        agents,
        q.zoneId ?? null,
        q.category ?? null,
        q.side ?? null,
        q.productId ?? null,
      ],
    };
  }

  /** Chiffres clés de la période. */
  async overview(user: AuthUser, q: InsightsQuery) {
    const { params, from, to } = await this.scope(user, q);
    const [row] = await this.db.manager.query<Record<string, number | null>[]>(
      `WITH ${READINGS}, ${LATEST_PRESENCE}
       SELECT (SELECT count(DISTINCT submission_id) FROM readings)::int AS visits,
              (SELECT count(DISTINCT outlet_id) FROM readings)::int AS outlets,
              (SELECT count(DISTINCT product_id) FROM readings)::int AS products,
              (SELECT count(*) FROM latest WHERE own AND NOT presence)::int AS "ownStockouts",
              (SELECT count(*) FROM latest WHERE own)::int AS "ownChecked",
              (SELECT coalesce(sum(sold), 0) FROM readings WHERE own)::float8 AS "ownSold",
              (SELECT coalesce(sum(sold), 0) FROM readings WHERE NOT own)::float8 AS "competitorSold",
              (SELECT coalesce(sum(losses), 0) FROM readings WHERE own)::float8 AS "ownLosses"`,
      params,
    );
    return {
      from,
      to,
      ...row,
      stockoutRate: row.ownChecked
        ? Math.round(((row.ownStockouts ?? 0) / row.ownChecked) * 100)
        : null,
    };
  }

  /**
   * Ruptures en cours : produits dont le dernier relevé de la période dans un point de vente
   * est « rupture » ; et, par produit, le taux de rupture parmi les points de vente relevés.
   */
  async stockouts(user: AuthUser, q: InsightsQuery) {
    const { params } = await this.scope(user, q);
    const byProduct = await this.db.manager.query<Record<string, unknown>[]>(
      `WITH ${READINGS}, ${LATEST_PRESENCE}
       SELECT product_id AS "productId", product_name AS name, format, own, category,
              count(*)::int AS checked,
              count(*) FILTER (WHERE NOT presence)::int AS stockouts,
              round(100.0 * count(*) FILTER (WHERE NOT presence) / count(*))::int AS rate
       FROM latest GROUP BY product_id, product_name, format, own, category
       ORDER BY rate DESC, stockouts DESC, name`,
      params,
    );
    const outlets = await this.db.manager.query<Record<string, unknown>[]>(
      `WITH ${READINGS}, ${LATEST_PRESENCE}
       SELECT l.product_id AS "productId", l.product_name AS "productName", l.format, l.own,
              l.outlet_id AS "outletId", l.outlet_name AS "outletName", l.zone_name AS zone,
              l.submitted_at AS since,
              ST_Y(l.location) AS lat, ST_X(l.location) AS lng,
              trim(u.first_name || ' ' || u.last_name) AS agent
       FROM latest l LEFT JOIN users u ON u.id = l.agent_id
       WHERE NOT l.presence
       ORDER BY l.own DESC, l.submitted_at DESC
       LIMIT 500`,
      params,
    );
    return { byProduct, outlets };
  }

  /** Ventes, pertes et commandes par produit (nos produits et la concurrence). */
  async sales(user: AuthUser, q: InsightsQuery) {
    const { params } = await this.scope(user, q);
    const products = await this.db.manager.query<Record<string, unknown>[]>(
      `WITH ${READINGS}
       SELECT product_id AS "productId", product_name AS name, format, own, category, unit, packagings,
              coalesce(sum(sold), 0)::float8 AS sold,
              coalesce(sum(losses), 0)::float8 AS losses,
              coalesce(sum(ordered), 0)::float8 AS ordered,
              count(DISTINCT outlet_id)::int AS outlets
       FROM readings
       GROUP BY product_id, product_name, format, own, category, unit, packagings
       HAVING sum(sold) IS NOT NULL OR sum(losses) IS NOT NULL OR sum(ordered) IS NOT NULL
       ORDER BY sold DESC, name`,
      params,
    );
    // Points de vente aux pertes les plus fortes.
    const lossOutlets = await this.db.manager.query<Record<string, unknown>[]>(
      `WITH ${READINGS}
       SELECT outlet_id AS "outletId", outlet_name AS "outletName", zone_name AS zone,
              coalesce(sum(losses), 0)::float8 AS losses,
              count(DISTINCT product_id) FILTER (WHERE losses > 0)::int AS products
       FROM readings WHERE outlet_id IS NOT NULL AND losses > 0
       GROUP BY outlet_id, outlet_name, zone_name
       ORDER BY losses DESC LIMIT 20`,
      params,
    );
    return { products, lossOutlets };
  }

  /**
   * Prix constatés par produit (moyenne, minimum, maximum), par zone, et comparaison de nos
   * produits avec ceux de la concurrence de la même catégorie.
   */
  async prices(user: AuthUser, q: InsightsQuery) {
    const { params } = await this.scope(user, q);
    const products = await this.db.manager.query<Record<string, unknown>[]>(
      `WITH ${READINGS}
       SELECT product_id AS "productId", product_name AS name, format, own, category, unit,
              round(avg(price))::float8 AS avg, min(price)::float8 AS min, max(price)::float8 AS max,
              count(price)::int AS readings
       FROM readings WHERE price IS NOT NULL
       GROUP BY product_id, product_name, format, own, category, unit
       ORDER BY category NULLS LAST, own DESC, name`,
      params,
    );
    const byZone = await this.db.manager.query<
      { productId: string; zone: string; avg: number }[]
    >(
      `WITH ${READINGS}
       SELECT product_id AS "productId", coalesce(zone_name, 'Hors zone') AS zone,
              round(avg(price))::float8 AS avg
       FROM readings WHERE price IS NOT NULL
       GROUP BY product_id, coalesce(zone_name, 'Hors zone')
       ORDER BY zone`,
      params,
    );
    // Par catégorie : prix moyen de nos produits et de la concurrence, et l'écart.
    const categories = await this.db.manager.query<Record<string, unknown>[]>(
      `WITH ${READINGS}
       SELECT coalesce(category, 'Sans catégorie') AS category,
              round(avg(price) FILTER (WHERE own))::float8 AS own,
              round(avg(price) FILTER (WHERE NOT own))::float8 AS competitor
       FROM readings WHERE price IS NOT NULL
       GROUP BY coalesce(category, 'Sans catégorie')
       HAVING avg(price) FILTER (WHERE own) IS NOT NULL AND avg(price) FILTER (WHERE NOT own) IS NOT NULL
       ORDER BY category`,
      params,
    );
    return {
      products: products.map((p) => ({
        ...p,
        zones: byZone
          .filter((z) => z.productId === p.productId)
          .map(({ zone, avg }) => ({ zone, avg })),
      })),
      categories: categories.map((c) => ({
        ...c,
        gapPercent: Math.round(
          ((Number(c.own) - Number(c.competitor)) / Number(c.competitor)) * 100,
        ),
      })),
    };
  }

  /**
   * Point de vente : le dernier relevé de chaque produit et l'évolution du stock (10 derniers
   * relevés), sur toute la période disponible.
   */
  async outlet(user: AuthUser, outletId: string) {
    const agents =
      user.role === Role.Admin ? null : await this.access.agentScope(user);
    const rows = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT pr.product_id AS "productId", p.name, p.format, p.own, p.unit, p.packagings,
              pr.presence, pr.stock::float8 AS stock, pr.price::float8 AS price,
              pr.sold::float8 AS sold, pr.losses::float8 AS losses, pr.ordered::float8 AS ordered,
              pr.submitted_at AS "at"
       FROM product_readings pr
       JOIN mission_submissions s ON s.id = pr.submission_id AND s.status = 'accepted'
       JOIN products p ON p.id = pr.product_id
       WHERE pr.outlet_id = $1 AND ($2::uuid[] IS NULL OR pr.agent_id = ANY($2::uuid[]))
       ORDER BY p.own DESC, p.name, pr.submitted_at DESC`,
      [outletId, agents],
    );
    const byProduct = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const id = r.productId as string;
      byProduct.set(id, [...(byProduct.get(id) ?? []), r]);
    }
    return [...byProduct.values()].map((list) => {
      const [last] = list;
      return {
        productId: last.productId,
        name: last.name,
        format: last.format,
        own: last.own,
        unit: last.unit,
        packagings: last.packagings,
        last: {
          at: last.at,
          presence: last.presence,
          stock: last.stock,
          price: last.price,
          sold: last.sold,
          losses: last.losses,
          ordered: last.ordered,
        },
        stockHistory: list
          .filter((r) => r.stock !== null)
          .slice(0, 10)
          .reverse()
          .map((r) => ({ at: r.at, stock: r.stock })),
      };
    });
  }
}
