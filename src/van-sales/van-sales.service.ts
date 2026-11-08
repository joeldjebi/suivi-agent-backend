import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  OrderKind,
  OrderStatus,
  PAYMENT_METHOD_LABELS,
  Role,
  SALE_FLAG_LABELS,
  SaleFlag,
  StockMovementKind,
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
import { NotificationsService } from '../common/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../orders/payments.service';
import { distanceM, OutletsService } from '../outlets/outlets.service';
import type { OutletView } from '../outlets/outlets.service';
import { assertPresence } from '../outlets/visit-rules';
import { receiptPdf } from './receipt';
import { StockService } from './stock.service';
import type {
  CashQuery,
  CreatePaymentDto,
  CreateSaleDto,
  OutletSearchQuery,
  RemittanceDto,
} from './van-sales.dto';

/**
 * Au-delà de ce délai, une vente ou un paiement arrive d'un téléphone resté sans réseau :
 * c'est déjà fait chez le client, on l'enregistre en le signalant plutôt que de le refuser.
 */
const LIVE_MS = 2 * 60_000;

const money = (n: number) => Math.round(n * 100) / 100;

/**
 * Vente en camionnette : vente directe depuis le camion de l'agent (livrée sur place, payée
 * en tout ou partie, le reste à crédit dans la limite du plafond du client), paiements reçus
 * des clients, caisse de l'agent et remises à un responsable.
 */
@Injectable()
export class VanSalesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly outlets: OutletsService,
    private readonly stock: StockService,
  ) {}

  private tx<T>(fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return fn(this.db.manager);
  }

  // ------------------------------------------------------------ ventes

  async sell(user: AuthUser, dto: CreateSaleDto) {
    const m = this.db.manager;
    const [existing] = await m.query<{ id: string }[]>(
      `SELECT id FROM orders WHERE agent_id = $1 AND client_id = $2`,
      [user.id, dto.clientId],
    );
    if (existing) return this.orders.get(user, existing.id);

    const van = await this.stock.requireVan(user);
    const soldAt = dto.soldAt ? new Date(dto.soldAt) : new Date();
    if (soldAt.getTime() > Date.now() + 5 * 60_000)
      throw badRequest('INVALID_DATE', 'L’heure de la vente est dans le futur');
    const live = Date.now() - soldAt.getTime() < LIVE_MS;

    const target = await this.saleOutlet(user, dto);
    const { outlet, priceList, currency, lines, total } =
      await this.orders.price(user, dto.outletId, dto.lines, target.outlet);
    const paid = money(dto.paidAmount);
    if (paid > total)
      throw badRequest(
        'PAID_TOO_MUCH',
        'Le montant payé dépasse le total de la vente',
      );
    if (paid > 0 && !dto.paymentMethod)
      throw badRequest(
        'PAYMENT_METHOD_REQUIRED',
        'Indiquez le moyen de paiement',
      );
    const credit = money(total - paid);

    const flags: SaleFlag[] = target.outOfZone ? [SaleFlag.OutOfZone] : [];
    // Stock du camion.
    const stock = await this.stock.quantities(
      van.id,
      lines.map((l) => l.productId),
    );
    const short = lines.find((l) => (stock.get(l.productId) ?? 0) < l.quantity);
    if (short) {
      if (live)
        throw badRequest(
          'INSUFFICIENT_STOCK',
          `Stock du camion insuffisant pour « ${short.name} » : ${Math.max(0, stock.get(short.productId) ?? 0)} disponible(s)`,
        );
      flags.push(SaleFlag.NegativeStock);
    }
    // Crédit du client.
    if (credit > 0) {
      const balance = await this.payments.balance(outlet.id);
      if (balance.creditLimit == null || credit > balance.available) {
        if (live)
          throw badRequest(
            balance.creditLimit == null
              ? 'CREDIT_NOT_ALLOWED'
              : 'CREDIT_LIMIT_EXCEEDED',
            balance.creditLimit == null
              ? `« ${outlet.name} » n’a pas droit au crédit : la vente doit être payée en entier`
              : `Crédit possible pour « ${outlet.name} » : ${balance.available} ${currency} au plus`,
          );
        flags.push(SaleFlag.OverCreditLimit);
      }
    }

    const distance =
      dto.lat != null &&
      dto.lng != null &&
      outlet.lat != null &&
      outlet.lng != null
        ? Math.round(distanceM(dto.lat, dto.lng, outlet.lat, outlet.lng))
        : null;
    const status = credit > 0 ? OrderStatus.Delivered : OrderStatus.Paid;

    const id = await this.tx(async (t) => {
      const next = await this.orders.nextNumber(t);
      const [{ id }] = await t.query<{ id: string }[]>(
        `INSERT INTO orders (tenant_id, number, client_id, outlet_id, agent_id, price_list_id,
                             price_list_name, total, currency, note, lat, lng, distance_m, taken_at,
                             kind, location_id, status, delivered_at, paid_at, flags,
                             out_of_zone_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 'sale', $15, $16, $14, $17, $18, $19) RETURNING id`,
        [
          this.db.tenantId,
          next,
          dto.clientId,
          outlet.id,
          user.id,
          priceList.id,
          priceList.name,
          total,
          currency,
          dto.note || null,
          dto.lat ?? null,
          dto.lng ?? null,
          distance,
          soldAt,
          van.id,
          status,
          status === OrderStatus.Paid ? soldAt : null,
          flags,
          target.outOfZone ? dto.outOfZoneReason! : null,
        ],
      );
      await this.orders.insertLines(t, id, lines);
      await t.query(
        `INSERT INTO order_events (tenant_id, order_id, status, user_id, comment, created_at)
         VALUES ($1, $2, $3, $4, 'Vente directe depuis le camion', $5)`,
        [this.db.tenantId, id, status, user.id, soldAt],
      );
      // La marchandise sort du camion.
      await this.stock.insertMovement(t, {
        kind: StockMovementKind.Sale,
        from: van.id,
        orderId: id,
        createdBy: user.id,
        occurredAt: soldAt,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
        })),
      });
      await this.stock.apply(
        t,
        van.id,
        lines.map((l) => ({ productId: l.productId, quantity: -l.quantity })),
      );
      // L'argent reçu sur place règle cette vente d'abord.
      if (paid > 0) {
        const paymentId = await this.payments.insert(t, {
          clientId: dto.clientId,
          outletId: outlet.id,
          agentId: user.id,
          amount: paid,
          method: dto.paymentMethod!,
          receivedAt: soldAt,
          createdBy: user.id,
        });
        await t.query(
          `INSERT INTO payment_allocations (tenant_id, payment_id, order_id, amount)
           VALUES ($1, $2, $3, $4)`,
          [this.db.tenantId, paymentId, id, paid],
        );
        await t.query(`UPDATE orders SET paid_amount = $2 WHERE id = $1`, [
          id,
          paid,
        ]);
      }
      // Une avance versée plus tôt par le client règle le crédit de cette vente.
      if (credit > 0) await this.payments.settle(t, outlet.id, user.id);
      return id;
    });

    if (target.outOfZone) await this.outOfZone(user, id, outlet, dto);
    const toVerify = flags.filter((f) => f !== SaleFlag.OutOfZone);
    if (toVerify.length) await this.signal(user, id, toVerify);
    return this.orders.get(user, id);
  }

  /** Clients de toute la structure, pour une vente d'urgence hors zone. */
  searchOutlets(user: AuthUser, q: OutletSearchQuery) {
    return this.outlets.searchAll(user, q);
  }

  /** Client hors zone choisi : ses informations, ses prix et son crédit (préparer la vente). */
  async outOfZoneContext(user: AuthUser, outletId: string) {
    const outlet = await this.outlets.findAny(outletId);
    const [catalog, balance] = await Promise.all([
      this.orders.catalog(user, outletId, outlet),
      this.payments.balance(outletId),
    ]);
    return {
      outlet: {
        id: outlet.id,
        name: outlet.name,
        category: outlet.category,
        landmark: outlet.landmark,
        lat: outlet.lat,
        lng: outlet.lng,
        zoneName: outlet.zone?.name ?? null,
        status: outlet.status,
      },
      catalog,
      balance,
    };
  }

  /**
   * Client de la vente : dans le périmètre de l'agent ; sinon, vente d'urgence hors zone,
   * seulement avec un motif et l'agent sur place (distance des visites, 50 m au moins).
   */
  private async saleOutlet(
    user: AuthUser,
    dto: CreateSaleDto,
  ): Promise<{ outlet: OutletView; outOfZone: boolean }> {
    try {
      return {
        outlet: await this.outlets.findForVisit(user, dto.outletId),
        outOfZone: false,
      };
    } catch (error) {
      if (!dto.outOfZoneReason || (error as { status?: number }).status !== 404)
        throw error;
    }
    const outlet = await this.outlets.findAny(dto.outletId);
    if (outlet.lat == null || outlet.lng == null)
      throw badRequest(
        'OUTLET_NOT_LOCATED',
        `« ${outlet.name} » n’a pas de position : la vente hors zone se fait sur place, chez un client localisé`,
      );
    const settings = await this.access.settings();
    assertPresence(
      outlet,
      { lat: dto.lat, lng: dto.lng, accuracy: dto.accuracy },
      Math.max(settings.visitRadiusMeters ?? 0, 50),
    );
    return { outlet, outOfZone: true };
  }

  /**
   * Vente hors zone enregistrée : la sortie de zone en cours est justifiée, et les chefs (de
   * l'agent et de la zone du client) sont prévenus.
   */
  private async outOfZone(
    user: AuthUser,
    orderId: string,
    outlet: OutletView,
    dto: CreateSaleDto,
  ) {
    const m = this.db.manager;
    const reason = dto.outOfZoneReason!;
    await m.query(
      `UPDATE zone_exits SET justification = $2 WHERE agent_id = $1 AND ended_at IS NULL`,
      [user.id, `Vente hors zone chez ${outlet.name} : ${reason}`],
    );
    const agent = await this.access.getAgent(user.id);
    const approvers = await this.access.approverIds(
      agent,
      await this.access.settings(),
    );
    const zoneLeaders = await m.query<{ id: string }[]>(
      `SELECT DISTINCT g.leader_id AS id
       FROM groups g
       JOIN group_zones gz ON gz.group_id = g.id
       JOIN zones z ON z.id = gz.zone_id
       WHERE g.is_active AND g.leader_id IS NOT NULL AND z.is_active
         AND ST_Covers(z.area, (SELECT location FROM outlets WHERE id = $1))`,
      [outlet.id],
    );
    const order = await this.orders.get(user, orderId);
    await this.notifications.notify(
      [...approvers, ...zoneLeaders.map((l) => l.id)].filter(
        (id) => id !== user.id,
      ),
      {
        type: 'sale.out_of_zone',
        title: 'Vente hors zone',
        body: `${order.reference} · ${agent.firstName} ${agent.lastName} chez ${outlet.name} : ${reason}`,
        data: { orderId, outletId: outlet.id },
      },
    );
  }

  /** Vente arrivée sans réseau et incohérente : les responsables de l'agent sont prévenus. */
  private async signal(user: AuthUser, orderId: string, flags: SaleFlag[]) {
    const agent = await this.access.getAgent(user.id);
    const approvers = await this.access.approverIds(
      agent,
      await this.access.settings(),
    );
    const order = await this.orders.get(user, orderId);
    await this.notifications.notify(approvers, {
      type: 'sale.flagged',
      title: 'Vente à vérifier',
      body: `${order.reference} · ${order.agentName} chez ${order.outletName} : ${flags
        .map((f) => SALE_FLAG_LABELS[f].toLowerCase())
        .join(', ')}`,
      data: { orderId },
    });
  }

  /**
   * Vente annulée par un responsable : la marchandise revient dans le camion et l'argent
   * reçu pour elle est rendu au client (il sort de la caisse de l'agent).
   */
  async cancelSale(user: AuthUser, id: string, reason: string) {
    const order = await this.orders.get(user, id);
    if (order.kind !== OrderKind.Sale)
      throw conflict('NOT_A_SALE', 'Ce n’est pas une vente directe');
    if (order.status === OrderStatus.Cancelled)
      throw conflict('ALREADY_CANCELLED', 'Cette vente est déjà annulée');
    await this.tx(async (t) => {
      await t.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2,
                updated_at = now()
         WHERE id = $1`,
        [id, reason],
      );
      await t.query(
        `INSERT INTO order_events (tenant_id, order_id, status, user_id, comment)
         VALUES ($1, $2, 'cancelled', $3, $4)`,
        [this.db.tenantId, id, user.id, reason],
      );
      if (order.locationId) {
        const lines = order.lines.map((l) => ({
          productId: l.productId as string,
          quantity: Number(l.quantity),
        }));
        await this.stock.insertMovement(t, {
          kind: StockMovementKind.SaleCancel,
          to: order.locationId,
          orderId: id,
          note: reason,
          createdBy: user.id,
          lines,
        });
        await this.stock.apply(t, order.locationId, lines);
      }
      await this.payments.release(t, id, true);
    });
    return this.orders.get(user, id);
  }

  // ------------------------------------------------------------ paiements et crédit

  /** Solde du point de vente : dû, avance, plafond, crédit encore possible, commandes dues. */
  async balance(user: AuthUser, outletId: string) {
    const outlet = await this.outlets.findForVisit(user, outletId);
    const [balance, dues] = await Promise.all([
      this.payments.balance(outlet.id),
      this.db.manager.query<
        {
          id: string;
          number: number;
          total: number;
          paidAmount: number;
          takenAt: Date;
        }[]
      >(
        `SELECT id, number, total::float8 AS total, paid_amount::float8 AS "paidAmount",
                taken_at AS "takenAt"
         FROM orders WHERE outlet_id = $1 AND status = 'delivered' AND total > paid_amount
         ORDER BY taken_at`,
        [outlet.id],
      ),
    ]);
    return {
      outletId: outlet.id,
      outletName: outlet.name,
      ...balance,
      dues: dues.map((d) => ({
        ...d,
        reference: orderNumber(d.number),
        due: money(d.total - d.paidAmount),
      })),
    };
  }

  async setCreditLimit(outletId: string, limit: number | null) {
    const [row] = await this.db.manager.query<{ id: string }[]>(
      `UPDATE outlets SET credit_limit = $2, updated_at = now() WHERE id = $1 RETURNING id`,
      [outletId, limit],
    );
    if (!row) throw notFound('Point de vente');
    return this.payments.balance(outletId);
  }

  /** Paiement reçu d'un client : il règle ses commandes dues, les plus anciennes d'abord. */
  async pay(user: AuthUser, dto: CreatePaymentDto) {
    const [existing] = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM payments WHERE created_by = $1 AND client_id = $2`,
      [user.id, dto.clientId],
    );
    if (existing) return this.payment(existing.id);
    const outlet = await this.outlets.findForVisit(user, dto.outletId);
    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
    if (receivedAt.getTime() > Date.now() + 5 * 60_000)
      throw badRequest('INVALID_DATE', 'L’heure du paiement est dans le futur');
    const live = Date.now() - receivedAt.getTime() < LIVE_MS;
    const balance = await this.payments.balance(outlet.id);
    // En direct, on n'encaisse pas plus que la dette (l'excédent resterait en avance).
    if (live && money(dto.amount) > balance.outstanding)
      throw badRequest(
        'OVERPAYMENT',
        balance.outstanding > 0
          ? `« ${outlet.name} » doit ${balance.outstanding} au plus`
          : `« ${outlet.name} » ne doit rien`,
      );
    const id = await this.tx(async (t) => {
      const id = await this.payments.insert(t, {
        clientId: dto.clientId,
        outletId: outlet.id,
        // L'argent reçu par un agent entre dans sa caisse.
        agentId: user.role === Role.Agent ? user.id : null,
        amount: dto.amount,
        method: dto.method,
        note: dto.note,
        receivedAt,
        createdBy: user.id,
      });
      await this.payments.settle(t, outlet.id, user.id);
      return id;
    });
    return this.payment(id);
  }

  async payment(id: string) {
    const [row] = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT p.id, p.outlet_id AS "outletId", o.name AS "outletName", p.agent_id AS "agentId",
              p.amount::float8 AS amount, p.method, p.note, p.received_at AS "receivedAt",
              p.refunded_at AS "refundedAt",
              coalesce((SELECT jsonb_agg(jsonb_build_object('orderId', a.order_id,
                          'reference', 'CMD-' || lpad(od.number::text, 6, '0'),
                          'amount', a.amount::float8) ORDER BY od.taken_at)
                        FROM payment_allocations a JOIN orders od ON od.id = a.order_id
                        WHERE a.payment_id = p.id), '[]') AS allocations
       FROM payments p JOIN outlets o ON o.id = p.outlet_id WHERE p.id = $1`,
      [id],
    );
    if (!row) throw notFound('Paiement');
    return {
      ...row,
      methodLabel: PAYMENT_METHOD_LABELS[row.method as 'cash'],
      balance: await this.payments.balance(row.outletId as string),
    };
  }

  // ------------------------------------------------------------ caisse

  private async today(): Promise<{ day: string; tz: string }> {
    const tz = (await this.access.settings()).timezone;
    const [{ day }] = await this.db.manager.query<{ day: string }[]>(
      `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day`,
      [tz],
    );
    return { day, tz };
  }

  /**
   * Caisse du jour, par agent : ventes, argent encaissé par moyen de paiement, reste dû sur
   * les ventes du jour, argent liquide à remettre (tout ce qui n'a pas encore été remis).
   */
  async cash(user: AuthUser, q: CashQuery) {
    const { day: today, tz } = await this.today();
    const day = q.date?.slice(0, 10) ?? today;
    let agents: string[] | null;
    if (user.role === Role.Agent) {
      if (q.agentId && q.agentId !== user.id)
        throw forbidden('Vous ne voyez que votre caisse');
      agents = [user.id];
    } else {
      agents = await this.access.agentScope(user);
      if (q.agentId) {
        if (agents && !agents.includes(q.agentId))
          throw forbidden('Cet agent n’est pas dans votre périmètre');
        agents = [q.agentId];
      }
    }
    const rows = await this.db.manager.query<
      {
        agentId: string;
        agentName: string;
        vanName: string | null;
        salesCount: number;
        salesAmount: number;
        dueOnSales: number;
        cash: number;
        mobileMoney: number;
        bank: number;
        remittedToday: number;
        cashBalance: number;
      }[]
    >(
      `WITH a AS (
         SELECT u.id, trim(u.first_name || ' ' || u.last_name) AS name FROM users u
         WHERE u.role = 'agent' AND ($1::uuid[] IS NULL OR u.id = ANY($1::uuid[]))
       ),
       s AS (
         SELECT o.agent_id, count(*)::int AS n, sum(o.total) AS amount,
                sum(o.total - o.paid_amount) FILTER (WHERE o.status = 'delivered') AS due
         FROM orders o
         WHERE o.kind = 'sale' AND o.status <> 'cancelled'
           AND (o.taken_at AT TIME ZONE $2)::date = $3::date
         GROUP BY o.agent_id
       ),
       p AS (
         SELECT p.agent_id,
                sum(p.amount) FILTER (WHERE p.method = 'cash') AS cash,
                sum(p.amount) FILTER (WHERE p.method = 'mobile_money') AS mobile,
                sum(p.amount) FILTER (WHERE p.method = 'bank') AS bank
         FROM payments p
         WHERE p.refunded_at IS NULL AND (p.received_at AT TIME ZONE $2)::date = $3::date
         GROUP BY p.agent_id
       ),
       r AS (
         SELECT agent_id, sum(amount) FILTER (WHERE (remitted_at AT TIME ZONE $2)::date = $3::date) AS today,
                sum(amount) AS total
         FROM cash_remittances GROUP BY agent_id
       ),
       c AS (
         SELECT agent_id, sum(amount) AS total FROM payments
         WHERE method = 'cash' AND refunded_at IS NULL GROUP BY agent_id
       )
       SELECT a.id AS "agentId", a.name AS "agentName",
              (SELECT name FROM stock_locations WHERE agent_id = a.id AND is_active) AS "vanName",
              coalesce(s.n, 0) AS "salesCount", coalesce(s.amount, 0)::float8 AS "salesAmount",
              coalesce(s.due, 0)::float8 AS "dueOnSales",
              coalesce(p.cash, 0)::float8 AS cash, coalesce(p.mobile, 0)::float8 AS "mobileMoney",
              coalesce(p.bank, 0)::float8 AS bank,
              coalesce(r.today, 0)::float8 AS "remittedToday",
              (coalesce(c.total, 0) - coalesce(r.total, 0))::float8 AS "cashBalance"
       FROM a
       LEFT JOIN s ON s.agent_id = a.id
       LEFT JOIN p ON p.agent_id = a.id
       LEFT JOIN r ON r.agent_id = a.id
       LEFT JOIN c ON c.agent_id = a.id
       WHERE s.agent_id IS NOT NULL OR p.agent_id IS NOT NULL OR r.agent_id IS NOT NULL
          OR coalesce(c.total, 0) <> 0
          OR EXISTS (SELECT 1 FROM stock_locations x WHERE x.agent_id = a.id AND x.is_active)
       ORDER BY a.name`,
      [agents, tz, day],
    );
    const remittances = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT r.id, r.agent_id AS "agentId", r.amount::float8 AS amount, r.note,
              r.remitted_at AS "remittedAt",
              nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS "receivedBy"
       FROM cash_remittances r LEFT JOIN users u ON u.id = r.received_by
       WHERE ($1::uuid[] IS NULL OR r.agent_id = ANY($1::uuid[]))
         AND (r.remitted_at AT TIME ZONE $2)::date = $3::date
       ORDER BY r.remitted_at`,
      [agents, tz, day],
    );
    const sum = (k: keyof (typeof rows)[number]) =>
      money(rows.reduce((s, r) => s + Number(r[k]), 0));
    return {
      day,
      agents: rows,
      remittances,
      totals: {
        salesCount: rows.reduce((s, r) => s + r.salesCount, 0),
        salesAmount: sum('salesAmount'),
        dueOnSales: sum('dueOnSales'),
        cash: sum('cash'),
        mobileMoney: sum('mobileMoney'),
        bank: sum('bank'),
        remittedToday: sum('remittedToday'),
        cashBalance: sum('cashBalance'),
      },
    };
  }

  /** Remise de caisse : le responsable reçoit l'argent liquide de l'agent. */
  async remit(user: AuthUser, dto: RemittanceDto) {
    await this.access.assertCanManageAgent(user, dto.agentId);
    const [{ balance }] = await this.db.manager.query<{ balance: number }[]>(
      `SELECT (coalesce((SELECT sum(amount) FROM payments
                         WHERE agent_id = $1 AND method = 'cash' AND refunded_at IS NULL), 0)
               - coalesce((SELECT sum(amount) FROM cash_remittances WHERE agent_id = $1), 0))::float8 AS balance`,
      [dto.agentId],
    );
    if (money(dto.amount) > money(balance))
      throw badRequest(
        'REMITTANCE_TOO_HIGH',
        `L’agent n’a que ${money(balance)} en caisse`,
      );
    const [{ id }] = await this.db.manager.query<{ id: string }[]>(
      `INSERT INTO cash_remittances (tenant_id, agent_id, amount, received_by, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        this.db.tenantId,
        dto.agentId,
        money(dto.amount),
        user.id,
        dto.note || null,
      ],
    );
    return { id, cashBalance: money(balance - dto.amount) };
  }

  // ------------------------------------------------------------ reçu

  /** Reçu PDF d'une vente ou d'une commande (visible par qui voit la commande). */
  async receipt(user: AuthUser, id: string) {
    const order = await this.orders.get(user, id);
    const tz = (await this.access.settings()).timezone;
    const [info] = await this.db.manager.query<
      {
        company: string;
        companyPhone: string | null;
        outletPhone: string | null;
        date: string;
      }[]
    >(
      `SELECT coalesce(nullif(b.display_name, ''), t.name) AS company,
              b.support_phone AS "companyPhone", ol.phone AS "outletPhone",
              to_char(o.taken_at AT TIME ZONE $2, 'DD/MM/YYYY à HH24:MI') AS date
       FROM orders o
       JOIN tenants t ON t.id = o.tenant_id
       JOIN outlets ol ON ol.id = o.outlet_id
       LEFT JOIN tenant_branding b ON b.tenant_id = o.tenant_id
       WHERE o.id = $1`,
      [id, tz],
    );
    const payments = await this.db.manager.query<
      { method: keyof typeof PAYMENT_METHOD_LABELS; amount: number }[]
    >(
      `SELECT p.method, sum(a.amount)::float8 AS amount
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
       WHERE a.order_id = $1 AND p.refunded_at IS NULL
       GROUP BY p.method ORDER BY p.method`,
      [id],
    );
    const balance = await this.payments.balance(order.outletId);
    const pdf = await receiptPdf({
      company: info.company,
      companyPhone: info.companyPhone,
      reference: order.reference,
      kindLabel: order.kind === OrderKind.Sale ? 'Vente' : 'Commande',
      date: info.date,
      outletName: order.outletName,
      outletPhone: info.outletPhone,
      agentName: order.agentName,
      lines: order.lines.map((l) => ({
        name: String(l.name),
        quantity: Number(l.quantity),
        unit: String(l.unit),
        unitPrice: Number(l.unitPrice),
        amount: Number(l.amount),
      })),
      total: order.total,
      paid: order.paidAmount,
      due: order.status === OrderStatus.Cancelled ? 0 : order.due,
      payments: payments.map((p) => ({
        label: `Payé · ${PAYMENT_METHOD_LABELS[p.method]}`,
        amount: p.amount,
      })),
      balance: balance.outstanding,
      currency: order.currency,
      cancelled: order.status === OrderStatus.Cancelled,
    });
    return { pdf, filename: `recu-${order.reference}.pdf` };
  }

  // ------------------------------------------------------------ agent

  /**
   * « Mon camion » : stock du camion, chargements à confirmer, retours en attente, ventes et
   * encaissements du jour, argent liquide à remettre. Sans camion : `van` à null.
   */
  async mine(user: AuthUser) {
    const van = await this.stock.vanOf(user.id);
    if (!van) return { van: null };
    const [levels, pending, cash, depots] = await Promise.all([
      this.stock.levels(user, van.id),
      this.stock.movements(user, { status: 'pending', page: 1, limit: 50 }),
      this.cash(user, {}),
      this.db.manager.query<{ id: string; name: string }[]>(
        `SELECT id, name FROM stock_locations WHERE kind = 'depot' AND is_active ORDER BY lower(name)`,
      ),
    ]);
    return {
      van,
      depots,
      stock: levels.products
        .map((p) => ({
          productId: p.id,
          name: p.name,
          format: p.format,
          category: p.category,
          unit: p.unit,
          packagings: p.packagings,
          quantity: p.quantities[van.id] ?? 0,
        }))
        .filter((p) => p.quantity !== 0),
      pending: pending.items,
      today: cash.agents[0] ?? null,
      day: cash.day,
    };
  }
}
