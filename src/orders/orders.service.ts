import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  ORDER_STATUS_LABELS,
  ORDER_TRANSITIONS,
  OrderStatus,
  Role,
  orderNumber,
} from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../common/business.exception';
import { DbService } from '../common/db.service';
import { PlatformSettings } from '../entities';
import { distanceM, OutletsService } from '../outlets/outlets.service';
import type {
  ChangeOrderStatusDto,
  CreateOrderDto,
  ListOrdersQuery,
  OrdersSummaryQuery,
  PriceListDto,
  SetPricesDto,
  UpdatePriceListDto,
} from './orders.dto';

export interface PriceList {
  id: string;
  name: string;
  isDefault: boolean;
  /** Points de vente rattachés */
  outlets: number;
}

interface OrderRow {
  id: string;
  number: number;
  outletId: string;
  outletName: string;
  agentId: string;
  agentName: string;
  priceListName: string | null;
  status: OrderStatus;
  total: number;
  currency: string;
  note: string | null;
  distance: number | null;
  takenAt: Date;
  deliveredAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  lines: number;
}

const ORDER_SELECT = `
  o.id, o.number, o.outlet_id AS "outletId", ol.name AS "outletName",
  o.agent_id AS "agentId", trim(u.first_name || ' ' || u.last_name) AS "agentName",
  o.price_list_name AS "priceListName", o.status, o.total::float8 AS total, o.currency,
  o.note, o.distance_m AS distance, o.taken_at AS "takenAt",
  o.delivered_at AS "deliveredAt", o.paid_at AS "paidAt", o.cancelled_at AS "cancelledAt",
  o.cancel_reason AS "cancelReason",
  (SELECT count(*) FROM order_lines l WHERE l.order_id = o.id)::int AS lines`;
const ORDER_FROM = `
  FROM orders o
  JOIN outlets ol ON ol.id = o.outlet_id
  JOIN users u ON u.id = o.agent_id`;

const view = (r: OrderRow) => ({ ...r, reference: orderNumber(r.number) });

/**
 * Prise de commande terrain : types de client (listes de tarifs) et prix définis par la
 * structure, commandes prises par l'agent chez le point de vente avec les prix de son type de
 * client (calculés ici, jamais par le téléphone), puis livrées et payées.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly outlets: OutletsService,
  ) {}

  /** Chaque requête est déjà une transaction (RLS) : tout ce bloc est validé ou annulé ensemble. */
  private tx<T>(fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return fn(this.db.manager);
  }

  // ------------------------------------------------------------ types de client

  priceLists(): Promise<PriceList[]> {
    return this.db.manager.query<PriceList[]>(
      `SELECT pl.id, pl.name, pl.is_default AS "isDefault",
              (SELECT count(*) FROM outlets o WHERE o.price_list_id = pl.id)::int AS outlets
       FROM price_lists pl ORDER BY pl.is_default DESC, pl.name`,
    );
  }

  private async priceList(id: string): Promise<PriceList> {
    const list = (await this.priceLists()).find((l) => l.id === id);
    if (!list) throw notFound('Type de client');
    return list;
  }

  async createPriceList(dto: PriceListDto) {
    await this.assertNameFree(dto.name);
    const lists = await this.priceLists();
    // Le premier type de client créé s'applique par défaut.
    const isDefault = dto.isDefault ?? lists.length === 0;
    return this.tx(async (m) => {
      if (isDefault)
        await m.query(
          `UPDATE price_lists SET is_default = false WHERE is_default`,
        );
      const [{ id }] = await m.query<{ id: string }[]>(
        `INSERT INTO price_lists (tenant_id, name, is_default) VALUES ($1, $2, $3) RETURNING id`,
        [this.db.tenantId, dto.name, isDefault],
      );
      return id;
    }).then((id) => this.priceList(id));
  }

  async updatePriceList(id: string, dto: UpdatePriceListDto) {
    const list = await this.priceList(id);
    if (dto.name !== undefined && dto.name !== list.name)
      await this.assertNameFree(dto.name, id);
    if (dto.isDefault === false && list.isDefault)
      throw badRequest(
        'DEFAULT_PRICE_LIST_REQUIRED',
        'Choisissez un autre type de client par défaut à la place',
      );
    await this.tx(async (m) => {
      if (dto.isDefault && !list.isDefault)
        await m.query(
          `UPDATE price_lists SET is_default = false WHERE is_default`,
        );
      await m.query(
        `UPDATE price_lists SET name = coalesce($2, name),
                is_default = coalesce($3, is_default), updated_at = now()
         WHERE id = $1`,
        [id, dto.name ?? null, dto.isDefault ?? null],
      );
    });
    return this.priceList(id);
  }

  /** Suppression : ses points de vente passent au type de client par défaut. */
  async removePriceList(id: string) {
    const list = await this.priceList(id);
    if (list.isDefault)
      throw badRequest(
        'DEFAULT_PRICE_LIST_REQUIRED',
        'Le type de client par défaut ne peut pas être supprimé : choisissez-en un autre par défaut d’abord',
      );
    await this.db.manager.query(`DELETE FROM price_lists WHERE id = $1`, [id]);
  }

  private async assertNameFree(name: string, except?: string) {
    const [taken] = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM price_lists WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2`,
      [name, except ?? null],
    );
    if (taken)
      throw conflict(
        'PRICE_LIST_EXISTS',
        `Le type de client « ${name} » existe déjà`,
      );
  }

  // ------------------------------------------------------------ prix

  /** Grille des prix : nos produits actifs, et leur prix pour chaque type de client. */
  async prices() {
    const [priceLists, products] = await Promise.all([
      this.priceLists(),
      this.db.manager.query<Record<string, unknown>[]>(
        `SELECT p.id, p.name, p.format, p.category, p.unit, p.packagings,
                coalesce((SELECT jsonb_object_agg(pp.price_list_id, pp.price::float8)
                          FROM product_prices pp WHERE pp.product_id = p.id), '{}') AS prices
         FROM products p WHERE p.own AND p.is_active
         ORDER BY p.category NULLS LAST, p.name`,
      ),
    ]);
    return { currency: await this.currency(), priceLists, products };
  }

  async setPrices(dto: SetPricesDto) {
    const lists = new Set((await this.priceLists()).map((l) => l.id));
    const ids = [...new Set(dto.items.map((i) => i.productId))];
    const found = ids.length
      ? await this.db.manager.query<{ id: string }[]>(
          `SELECT id FROM products WHERE id = ANY($1::uuid[]) AND own`,
          [ids],
        )
      : [];
    const products = new Set(found.map((p) => p.id));
    for (const i of dto.items) {
      if (!lists.has(i.priceListId)) throw notFound('Type de client');
      if (!products.has(i.productId))
        throw badRequest(
          'PRODUCT_NOT_SOLD',
          'Seuls les produits de la structure (pas ceux de la concurrence) ont un prix de vente',
        );
    }
    await this.tx(async (m) => {
      for (const i of dto.items) {
        if (i.price == null)
          await m.query(
            `DELETE FROM product_prices WHERE price_list_id = $1 AND product_id = $2`,
            [i.priceListId, i.productId],
          );
        else
          await m.query(
            `INSERT INTO product_prices (tenant_id, price_list_id, product_id, price)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (price_list_id, product_id)
             DO UPDATE SET price = excluded.price, updated_at = now()`,
            [this.db.tenantId, i.priceListId, i.productId, i.price],
          );
      }
    });
    return this.prices();
  }

  /** Type de client appliqué au point de vente : le sien, sinon celui par défaut. */
  private async listFor(
    priceListId: string | null,
  ): Promise<{ id: string; name: string } | null> {
    const [row] = await this.db.manager.query<{ id: string; name: string }[]>(
      `SELECT id, name FROM price_lists
       WHERE id = $1 OR ($1::uuid IS NULL AND is_default)
       ORDER BY (id = $1) DESC NULLS LAST LIMIT 1`,
      [priceListId],
    );
    return row ?? null;
  }

  /** Catalogue de l'agent pour un point de vente : les produits qui ont un prix pour lui. */
  async catalog(user: AuthUser, outletId: string) {
    const outlet = await this.outlets.findForVisit(user, outletId);
    const list = await this.listFor(outlet.priceList?.id ?? null);
    const products = list
      ? await this.db.manager.query<Record<string, unknown>[]>(
          `SELECT p.id, p.name, p.format, p.category, p.unit, p.packagings,
                  pp.price::float8 AS price
           FROM products p JOIN product_prices pp ON pp.product_id = p.id
           WHERE pp.price_list_id = $1 AND p.own AND p.is_active
           ORDER BY p.category NULLS LAST, p.name`,
          [list.id],
        )
      : [];
    return { priceList: list, currency: await this.currency(), products };
  }

  private async currency(): Promise<string> {
    return (
      (await this.db.manager.findOneBy(PlatformSettings, { id: 1 }))
        ?.currency ?? 'XOF'
    );
  }

  // ------------------------------------------------------------ commandes

  /** Commande prise par l'agent chez le point de vente (idempotente sur clientId). */
  async create(user: AuthUser, dto: CreateOrderDto) {
    const m = this.db.manager;
    const [existing] = await m.query<{ id: string }[]>(
      `SELECT id FROM orders WHERE agent_id = $1 AND client_id = $2`,
      [user.id, dto.clientId],
    );
    if (existing) return this.get(user, existing.id);

    const outlet = await this.outlets.findForVisit(user, dto.outletId);
    if (outlet.status === 'closed')
      throw badRequest(
        'OUTLET_CLOSED',
        `« ${outlet.name} » est fermé : il ne peut plus commander`,
      );
    const catalog = await this.catalog(user, dto.outletId);
    if (!catalog.priceList)
      throw badRequest(
        'NO_PRICE_LIST',
        'Aucun type de client n’est défini : demandez à votre administrateur de fixer les prix',
      );
    const priced = new Map(catalog.products.map((p) => [p.id as string, p]));
    // Un même produit saisi deux fois : les quantités s'additionnent.
    const quantities = new Map<string, number>();
    for (const l of dto.lines)
      quantities.set(
        l.productId,
        (quantities.get(l.productId) ?? 0) + l.quantity,
      );
    const lines = [...quantities].map(([productId, quantity], position) => {
      const p = priced.get(productId);
      if (!p)
        throw badRequest(
          'PRODUCT_NOT_PRICED',
          'Un produit commandé n’a pas de prix pour ce type de client',
        );
      const unitPrice = Number(p.price);
      return {
        productId,
        name: [p.name, p.format].filter(Boolean).join(' '),
        unit: p.unit as string,
        quantity,
        unitPrice,
        amount: Math.round(quantity * unitPrice * 100) / 100,
        position,
      };
    });
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const distance =
      dto.lat != null &&
      dto.lng != null &&
      outlet.lat != null &&
      outlet.lng != null
        ? Math.round(distanceM(dto.lat, dto.lng, outlet.lat, outlet.lng))
        : null;
    const takenAt = dto.takenAt ? new Date(dto.takenAt) : new Date();
    if (takenAt.getTime() > Date.now() + 5 * 60_000)
      throw badRequest(
        'INVALID_DATE',
        'L’heure de la commande est dans le futur',
      );

    const id = await this.tx(async (t) => {
      // Numéro suivant de la structure, sans collision entre deux prises simultanées.
      await t.query(`SELECT pg_advisory_xact_lock(hashtext('orders:' || $1))`, [
        this.db.tenantId,
      ]);
      const [{ next }] = await t.query<{ next: number }[]>(
        `SELECT coalesce(max(number), 0) + 1 AS next FROM orders`,
      );
      const [{ id }] = await t.query<{ id: string }[]>(
        `INSERT INTO orders (tenant_id, number, client_id, outlet_id, agent_id, price_list_id,
                             price_list_name, total, currency, note, lat, lng, distance_m, taken_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [
          this.db.tenantId,
          next,
          dto.clientId,
          outlet.id,
          user.id,
          catalog.priceList!.id,
          catalog.priceList!.name,
          total,
          catalog.currency,
          dto.note || null,
          dto.lat ?? null,
          dto.lng ?? null,
          distance,
          takenAt,
        ],
      );
      for (const l of lines)
        await t.query(
          `INSERT INTO order_lines (tenant_id, order_id, product_id, product_name, unit, quantity,
                                    unit_price, amount, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            this.db.tenantId,
            id,
            l.productId,
            l.name,
            l.unit,
            l.quantity,
            l.unitPrice,
            l.amount,
            l.position,
          ],
        );
      await t.query(
        `INSERT INTO order_events (tenant_id, order_id, status, user_id) VALUES ($1, $2, 'taken', $3)`,
        [this.db.tenantId, id, user.id],
      );
      return id;
    });
    return this.get(user, id);
  }

  /**
   * Commandes visibles : l'administrateur toutes, le chef celles de ses agents, l'agent les
   * siennes — et, sur la fiche d'un point de vente qu'il voit, celles de ce point de vente.
   */
  private async where(
    user: AuthUser,
    outletId: string | null,
    p: (v: unknown) => string,
  ) {
    if (user.role === Role.Admin) return 'true';
    if (user.role === Role.Agent) {
      if (outletId) {
        await this.outlets.findForVisit(user, outletId);
        return 'true';
      }
      return `o.agent_id = ${p(user.id)}`;
    }
    return `o.agent_id = ANY(${p(await this.access.agentScope(user))}::uuid[])`;
  }

  private async filters(
    user: AuthUser,
    q: {
      status?: OrderStatus;
      outletId?: string;
      agentId?: string;
      from?: string;
      to?: string;
    },
  ) {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = [await this.where(user, q.outletId ?? null, p)];
    if (q.status) where.push(`o.status = ${p(q.status)}`);
    if (q.outletId) where.push(`o.outlet_id = ${p(q.outletId)}`);
    if (q.agentId) where.push(`o.agent_id = ${p(q.agentId)}`);
    if (q.from || q.to) {
      const tz = (await this.access.settings()).timezone;
      const day = `(o.taken_at AT TIME ZONE ${p(tz)})::date`;
      if (q.from) where.push(`${day} >= ${p(q.from.slice(0, 10))}::date`);
      if (q.to) where.push(`${day} <= ${p(q.to.slice(0, 10))}::date`);
    }
    return { where: where.join(' AND '), params, p };
  }

  async list(user: AuthUser, q: ListOrdersQuery) {
    const { where, params, p } = await this.filters(user, q);
    const [{ total }] = await this.db.manager.query<{ total: number }[]>(
      `SELECT count(*)::int AS total ${ORDER_FROM} WHERE ${where}`,
      params,
    );
    const rows = await this.db.manager.query<OrderRow[]>(
      `SELECT ${ORDER_SELECT} ${ORDER_FROM} WHERE ${where}
       ORDER BY o.taken_at DESC, o.number DESC
       LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    return { items: rows.map(view), total, page: q.page, limit: q.limit };
  }

  /** Chiffres de la période : nombre et montant par statut (hors annulées pour le total). */
  async summary(user: AuthUser, q: OrdersSummaryQuery) {
    const { where, params } = await this.filters(user, q);
    const rows = await this.db.manager.query<
      { status: OrderStatus; count: number; amount: number }[]
    >(
      `SELECT o.status, count(*)::int AS count, coalesce(sum(o.total), 0)::float8 AS amount
       ${ORDER_FROM} WHERE ${where} GROUP BY o.status`,
      params,
    );
    const byStatus = Object.fromEntries(
      Object.values(OrderStatus).map((s) => {
        const r = rows.find((x) => x.status === s);
        return [s, { count: r?.count ?? 0, amount: r?.amount ?? 0 }];
      }),
    ) as Record<OrderStatus, { count: number; amount: number }>;
    const live = rows.filter((r) => r.status !== OrderStatus.Cancelled);
    return {
      currency: await this.currency(),
      count: live.reduce((s, r) => s + r.count, 0),
      amount: live.reduce((s, r) => s + r.amount, 0),
      /** Livrées mais pas encore payées : à encaisser */
      toCollect: byStatus.delivered.amount,
      byStatus,
    };
  }

  async get(user: AuthUser, id: string) {
    const [row] = await this.db.manager.query<OrderRow[]>(
      `SELECT ${ORDER_SELECT} ${ORDER_FROM} WHERE o.id = $1`,
      [id],
    );
    if (!row) throw notFound('Commande');
    // L'agent voit ses commandes et celles des points de vente qu'il voit.
    if (user.role === Role.Agent && row.agentId !== user.id)
      await this.outlets.findForVisit(user, row.outletId);
    if (user.role === Role.TeamLead) {
      const agents = await this.access.agentScope(user);
      if (agents && !agents.includes(row.agentId)) throw notFound('Commande');
    }
    const [lines, events] = await Promise.all([
      this.db.manager.query<Record<string, unknown>[]>(
        `SELECT l.product_id AS "productId", l.product_name AS name, l.unit,
                l.quantity::float8 AS quantity, l.unit_price::float8 AS "unitPrice",
                l.amount::float8 AS amount, p.packagings
         FROM order_lines l LEFT JOIN products p ON p.id = l.product_id
         WHERE l.order_id = $1 ORDER BY l.position`,
        [id],
      ),
      this.db.manager.query<Record<string, unknown>[]>(
        `SELECT e.status, e.comment, e.created_at AS at,
                nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS "user"
         FROM order_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.order_id = $1 ORDER BY e.created_at, e.id`,
        [id],
      ),
    ]);
    return { ...view(row), lines, events };
  }

  /**
   * Livrée, payée ou annulée. L'agent fait avancer ses propres commandes et n'annule qu'une
   * commande encore « prise » ; le chef et l'administrateur gèrent celles de leur périmètre.
   */
  async changeStatus(user: AuthUser, id: string, dto: ChangeOrderStatusDto) {
    const order = await this.get(user, id);
    if (user.role === Role.Agent && order.agentId !== user.id)
      throw forbidden('Seul l’agent qui a pris la commande la fait avancer');
    if (!ORDER_TRANSITIONS[order.status].includes(dto.status))
      throw conflict(
        'INVALID_ORDER_STATUS',
        `Commande ${ORDER_STATUS_LABELS[order.status].toLowerCase()} : elle ne peut pas passer à « ${ORDER_STATUS_LABELS[dto.status].toLowerCase()} »`,
      );
    if (dto.status === OrderStatus.Cancelled) {
      if (!dto.comment)
        throw badRequest(
          'REASON_REQUIRED',
          'Indiquez le motif de l’annulation',
        );
      if (user.role === Role.Agent && order.status !== OrderStatus.Taken)
        throw forbidden(
          'Une commande livrée ne peut être annulée que par un responsable',
        );
    }
    await this.tx(async (t) => {
      await t.query(
        `UPDATE orders SET status = $2,
                delivered_at = CASE WHEN $2 IN ('delivered', 'paid') THEN coalesce(delivered_at, now()) ELSE delivered_at END,
                paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END,
                cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
                cancel_reason = CASE WHEN $2 = 'cancelled' THEN $3 ELSE cancel_reason END,
                updated_at = now()
         WHERE id = $1`,
        [id, dto.status, dto.comment ?? null],
      );
      await t.query(
        `INSERT INTO order_events (tenant_id, order_id, status, user_id, comment)
         VALUES ($1, $2, $3, $4, $5)`,
        [this.db.tenantId, id, dto.status, user.id, dto.comment || null],
      );
    });
    return this.get(user, id);
  }
}
