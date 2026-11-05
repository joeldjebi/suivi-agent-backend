import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { PaymentMethod } from '@suivi/shared';
import { DbService } from '../common/db.service';

/** Ce que doit un point de vente, et ce qu'il peut encore prendre à crédit. */
export interface OutletBalance {
  /** Plafond de crédit ; null : pas de vente à crédit */
  creditLimit: number | null;
  /** Reste à payer sur les commandes livrées */
  outstanding: number;
  /** Argent versé d'avance, pas encore affecté à une commande */
  advance: number;
  /** Crédit encore possible (0 sans plafond) */
  available: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Paiements des points de vente : l'argent reçu (espèces, mobile money, virement) règle les
 * commandes livrées, les plus anciennes d'abord. Un paiement fait au moment d'une vente règle
 * d'abord cette vente. Ce qui dépasse les sommes dues reste en avance pour les suivantes.
 */
@Injectable()
export class PaymentsService {
  constructor(private readonly db: DbService) {}

  /** Enregistre un paiement (sans le répartir) ; rend son identifiant. */
  async insert(
    m: EntityManager,
    p: {
      clientId: string | null;
      outletId: string;
      agentId: string | null;
      amount: number;
      method: PaymentMethod;
      note?: string | null;
      receivedAt: Date;
      createdBy: string;
    },
  ): Promise<string> {
    const [{ id }] = await m.query<{ id: string }[]>(
      `INSERT INTO payments (tenant_id, client_id, outlet_id, agent_id, amount, method, note,
                             received_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        this.db.tenantId,
        p.clientId,
        p.outletId,
        p.agentId,
        round(p.amount),
        p.method,
        p.note || null,
        p.receivedAt,
        p.createdBy,
      ],
    );
    return id;
  }

  /** Affecte (une partie d') un paiement à une commande précise. */
  async allocate(
    m: EntityManager,
    paymentId: string,
    orderId: string,
    amount: number,
    userId: string | null,
  ) {
    if (amount <= 0) return;
    await m.query(
      `INSERT INTO payment_allocations (tenant_id, payment_id, order_id, amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (payment_id, order_id)
       DO UPDATE SET amount = payment_allocations.amount + excluded.amount`,
      [this.db.tenantId, paymentId, orderId, round(amount)],
    );
    const [order] = await m.query<{ paid: boolean }[]>(
      `UPDATE orders SET paid_amount = least(total, paid_amount + $2), updated_at = now()
       WHERE id = $1 RETURNING paid_amount >= total AS paid`,
      [orderId, round(amount)],
    );
    // Entièrement réglée : la commande livrée passe à « payée ».
    if (order?.paid) {
      const [changed] = await m.query<{ id: string }[]>(
        `UPDATE orders SET status = 'paid', paid_at = coalesce(paid_at, now()), updated_at = now()
         WHERE id = $1 AND status = 'delivered' RETURNING id`,
        [orderId],
      );
      if (changed)
        await m.query(
          `INSERT INTO order_events (tenant_id, order_id, status, user_id, comment)
           VALUES ($1, $2, 'paid', $3, 'Réglée par paiement')`,
          [this.db.tenantId, orderId, userId],
        );
    }
  }

  /**
   * Répartit l'argent pas encore affecté du point de vente sur ses commandes dues, les plus
   * anciennes d'abord. À appeler dans la transaction qui ajoute un paiement ou une dette.
   */
  async settle(m: EntityManager, outletId: string, userId: string | null) {
    // Un point de vente à la fois : deux paiements simultanés ne règlent pas deux fois.
    await m.query(`SELECT 1 FROM outlets WHERE id = $1 FOR UPDATE`, [outletId]);
    const payments = await m.query<{ id: string; remaining: number }[]>(
      `SELECT p.id, (p.amount - coalesce(sum(a.amount), 0))::float8 AS remaining
       FROM payments p LEFT JOIN payment_allocations a ON a.payment_id = p.id
       WHERE p.outlet_id = $1 AND p.refunded_at IS NULL
       GROUP BY p.id, p.amount, p.received_at
       HAVING p.amount - coalesce(sum(a.amount), 0) > 0
       ORDER BY p.received_at, p.id`,
      [outletId],
    );
    if (!payments.length) return;
    const dues = await m.query<{ id: string; due: number }[]>(
      `SELECT id, (total - paid_amount)::float8 AS due FROM orders
       WHERE outlet_id = $1 AND status = 'delivered' AND total > paid_amount
       ORDER BY taken_at, number`,
      [outletId],
    );
    let d = 0;
    for (const p of payments) {
      let remaining = p.remaining;
      while (remaining > 0.004 && d < dues.length) {
        const part = round(Math.min(remaining, dues[d].due));
        await this.allocate(m, p.id, dues[d].id, part, userId);
        remaining = round(remaining - part);
        dues[d].due = round(dues[d].due - part);
        if (dues[d].due <= 0.004) d++;
      }
      if (d >= dues.length) break;
    }
  }

  async balance(outletId: string, m = this.db.manager): Promise<OutletBalance> {
    const [row] = await m.query<
      { creditLimit: number | null; outstanding: number; advance: number }[]
    >(
      `SELECT o.credit_limit::float8 AS "creditLimit",
              (SELECT coalesce(sum(total - paid_amount), 0) FROM orders
                WHERE outlet_id = o.id AND status = 'delivered')::float8 AS outstanding,
              (SELECT coalesce(sum(p.amount - coalesce(
                        (SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0)), 0)
                 FROM payments p WHERE p.outlet_id = o.id AND p.refunded_at IS NULL)::float8 AS advance
       FROM outlets o WHERE o.id = $1`,
      [outletId],
    );
    const creditLimit = row?.creditLimit ?? null;
    const outstanding = round(row?.outstanding ?? 0);
    const advance = round(row?.advance ?? 0);
    return {
      creditLimit,
      outstanding,
      advance,
      available:
        creditLimit == null
          ? 0
          : Math.max(0, round(creditLimit - outstanding + advance)),
    };
  }

  /**
   * Commande annulée : l'argent qui lui était affecté redevient libre ; s'il venait d'un
   * paiement fait pour elle seule (vente annulée), ce paiement est rendu au client.
   */
  async release(m: EntityManager, orderId: string, refund: boolean) {
    const allocations = await m.query<
      { paymentId: string; amount: number; total: number }[]
    >(
      `SELECT a.payment_id AS "paymentId", a.amount::float8 AS amount, p.amount::float8 AS total
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
       WHERE a.order_id = $1`,
      [orderId],
    );
    await m.query(`DELETE FROM payment_allocations WHERE order_id = $1`, [
      orderId,
    ]);
    await m.query(
      `UPDATE orders SET paid_amount = 0, updated_at = now() WHERE id = $1`,
      [orderId],
    );
    if (!refund) return;
    for (const a of allocations) {
      if (a.amount >= a.total)
        await m.query(`UPDATE payments SET refunded_at = now() WHERE id = $1`, [
          a.paymentId,
        ]);
      else
        await m.query(
          `UPDATE payments SET amount = amount - $2 WHERE id = $1`,
          [a.paymentId, a.amount],
        );
    }
  }
}
