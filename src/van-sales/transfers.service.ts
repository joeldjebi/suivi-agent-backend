import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  Role,
  StockMovementKind,
  TRANSFER_LEG_STATUS_LABELS,
  TRANSFER_STATUS_LABELS,
  TransferLegStatus,
  TransferStatus,
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
import { RealtimeService } from '../common/realtime.service';
import { NotificationsService } from '../common/notifications.service';
import { haversine } from '../outlets/route';
import { LiveService } from '../positions/live.service';
import { StockService } from './stock.service';
import type {
  AcceptTransferDto,
  CreateTransferDto,
  TransferHandoverDto,
  TransfersQuery,
} from './van-sales.dto';

/** Collègues prévenus au départ : les plus proches de l'équipe qui ont un des produits. */
const FIRST_WAVE = 5;
/** Sans réponse, la demande est élargie à tous ceux qui ont un des produits. */
const WIDEN_AFTER_MIN = 10;
/** Une part réservée sans remise est libérée pour les autres. */
const RESERVATION_MIN = 60;
/** Une demande non terminée se ferme d'elle-même. */
const EXPIRE_AFTER_H = 4;

type Line = { productId: string; quantity: number };

interface TransferRow {
  id: string;
  status: TransferStatus;
  requesterId: string;
  requesterName: string;
  requesterGroupId: string | null;
  requesterVanId: string;
  lines: Line[];
  note: string | null;
  token: string;
  notified: string[];
  widenedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
}

interface LegRow {
  id: string;
  transferId: string;
  giverId: string;
  giverName: string;
  giverVanId: string;
  status: TransferLegStatus;
  crossTeam: boolean;
  lines: Line[];
  decisionNote: string | null;
  acceptedAt: Date | null;
  movementId: string | null;
  doneAt: Date | null;
  releaseReason: string | null;
  createdAt: Date;
}

const T_SELECT = `
  t.id, t.status, t.requester_id AS "requesterId",
  trim(r.first_name || ' ' || r.last_name) AS "requesterName", r.group_id AS "requesterGroupId",
  t.requester_van_id AS "requesterVanId", t.lines, t.note, t.token, t.notified,
  t.widened_at AS "widenedAt", t.closed_at AS "closedAt", t.created_at AS "createdAt"
  FROM van_transfers t JOIN users r ON r.id = t.requester_id`;

const L_SELECT = `
  l.id, l.transfer_id AS "transferId", l.giver_id AS "giverId",
  trim(g.first_name || ' ' || g.last_name) AS "giverName", l.giver_van_id AS "giverVanId",
  l.status, l.cross_team AS "crossTeam", l.lines, l.decision_note AS "decisionNote",
  l.accepted_at AS "acceptedAt", l.movement_id AS "movementId", l.done_at AS "doneAt",
  l.release_reason AS "releaseReason", l.created_at AS "createdAt"
  FROM van_transfer_legs l JOIN users g ON g.id = l.giver_id`;

const OPEN: TransferStatus[] = [TransferStatus.Open, TransferStatus.Covered];
const ACTIVE: TransferLegStatus[] = [
  TransferLegStatus.Approval,
  TransferLegStatus.Accepted,
];

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Dépannage partagé entre camions. L'agent en rupture liste ce qu'il lui faut : la demande est
 * envoyée aux 5 collègues les plus proches de son équipe qui ont un des produits, puis élargie
 * après 10 minutes. Chaque collègue prend une part (réservée 1 h) ; le reste reste ouvert aux
 * autres. Un collègue d'une autre équipe attend l'accord de son chef. Sur place, il scanne le
 * code du demandeur et remet sa part : le stock passe d'un camion à l'autre (sans argent).
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly stock: StockService,
    private readonly live: LiveService,
    private readonly realtime: RealtimeService,
  ) {}

  // ------------------------------------------------------------ demande

  /** Demande de dépannage, diffusée aux collègues proches. Idempotente (clientId). */
  async create(user: AuthUser, dto: CreateTransferDto) {
    const m = this.db.manager;
    const [existing] = await m.query<{ id: string }[]>(
      `SELECT id FROM van_transfers WHERE requester_id = $1 AND client_id = $2`,
      [user.id, dto.clientId],
    );
    if (existing) return this.get(user, existing.id);
    const van = await this.stock.requireVan(user);
    const lines = await this.stock.validLines(dto.lines);
    const [{ id }] = await m.query<{ id: string }[]>(
      `INSERT INTO van_transfers (tenant_id, client_id, requester_id, requester_van_id, lines, note, token)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
      [
        this.db.tenantId,
        dto.clientId,
        user.id,
        van.id,
        JSON.stringify(lines),
        dto.note || null,
        randomBytes(18).toString('base64url'),
      ],
    );
    const transfer = await this.transfer(id);
    const candidates = await this.candidates(transfer, lines);
    const team = candidates.filter((c) => c.sameTeam);
    await this.notifyCandidates(
      transfer,
      (team.length ? team : candidates).slice(0, FIRST_WAVE),
      lines,
    );
    return this.get(user, id);
  }

  /**
   * Collègues dont le camion a au moins un des produits, les plus proches d'abord (positions
   * en direct du demandeur et du collègue ; position inconnue : en dernier).
   */
  private async candidates(transfer: TransferRow, lines: Line[]) {
    const productIds = lines
      .filter((l) => l.quantity > 0)
      .map((l) => l.productId);
    if (!productIds.length) return [];
    const rows = await this.db.manager.query<
      {
        agentId: string;
        groupId: string | null;
        quantities: Record<string, number>;
      }[]
    >(
      `SELECT u.id AS "agentId", u.group_id AS "groupId",
              jsonb_object_agg(lv.product_id, lv.quantity::float8) AS quantities
       FROM stock_locations sl
       JOIN users u ON u.id = sl.agent_id AND u.is_active
       JOIN stock_levels lv ON lv.location_id = sl.id AND lv.quantity > 0
                            AND lv.product_id = ANY($2::uuid[])
       WHERE sl.kind = 'van' AND sl.is_active AND u.id <> $1
       GROUP BY u.id`,
      [transfer.requesterId, productIds],
    );
    const teams = await this.teamsMatter();
    const positions = await this.live.all(this.db.tenantId);
    const here = positions.get(transfer.requesterId);
    return rows
      .map((r) => {
        const there = positions.get(r.agentId);
        return {
          ...r,
          sameTeam:
            !teams ||
            (r.groupId ?? null) === (transfer.requesterGroupId ?? null),
          distanceM:
            here && there
              ? Math.round(
                  haversine(
                    { lat: here.lat, lng: here.lng },
                    { lat: there.lat, lng: there.lng },
                  ),
                )
              : null,
        };
      })
      .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
  }

  private async notifyCandidates(
    transfer: TransferRow,
    candidates: { agentId: string; distanceM: number | null }[],
    lines: Line[],
  ) {
    const fresh = candidates.filter(
      (c) => !transfer.notified.includes(c.agentId),
    );
    if (!fresh.length) return;
    const summary = await this.summary(lines);
    for (const c of fresh)
      await this.notifications.notify([c.agentId], {
        type: 'transfer.requested',
        title: 'Demande de dépannage',
        body: `${transfer.requesterName}${c.distanceM != null ? ` (à ${formatDistance(c.distanceM)})` : ''} a besoin de : ${summary}`,
        data: { transferId: transfer.id },
      });
    await this.db.manager.query(
      `UPDATE van_transfers SET notified = notified || $2::uuid[], updated_at = now() WHERE id = $1`,
      [transfer.id, fresh.map((c) => c.agentId)],
    );
  }

  /** Groupes actifs : la demande reste d'abord dans l'équipe ; l'autre équipe demande un accord. */
  private async teamsMatter() {
    return (await this.access.settings()).useGroups;
  }

  /** « 2 × Coca-Cola 33 cl, 6 × Fanta ». */
  private async summary(lines: Line[]) {
    const names = await this.productNames(lines.map((l) => l.productId));
    return lines
      .filter((l) => l.quantity > 0)
      .map((l) => `${l.quantity} × ${names.get(l.productId) ?? 'produit'}`)
      .join(', ');
  }

  private async productNames(ids: string[]) {
    const rows = await this.db.manager.query<{ id: string; label: string }[]>(
      `SELECT id, concat_ws(' ', name, format) AS label FROM products WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((r) => [r.id, r.label]));
  }

  // ------------------------------------------------------------ quantités

  private async transfer(id: string, m: EntityManager = this.db.manager) {
    const [row] = await m.query<TransferRow[]>(
      `SELECT ${T_SELECT} WHERE t.id = $1`,
      [id],
    );
    if (!row) throw notFound('Dépannage');
    return row;
  }

  private legs(transferId: string, m: EntityManager = this.db.manager) {
    return m.query<LegRow[]>(
      `SELECT ${L_SELECT} WHERE l.transfer_id = $1 ORDER BY l.created_at`,
      [transferId],
    );
  }

  private async leg(id: string) {
    const [row] = await this.db.manager.query<LegRow[]>(
      `SELECT ${L_SELECT} WHERE l.id = $1`,
      [id],
    );
    if (!row) throw notFound('Part du dépannage');
    return row;
  }

  /** Quantités remises par part (lignes du mouvement « dépannage »). */
  private async given(legs: LegRow[], m: EntityManager = this.db.manager) {
    const ids = legs.map((l) => l.movementId).filter((x): x is string => !!x);
    const rows = ids.length
      ? await m.query<
          { movementId: string; productId: string; quantity: number }[]
        >(
          `SELECT movement_id AS "movementId", product_id AS "productId", quantity::float8 AS quantity
           FROM stock_movement_lines WHERE movement_id = ANY($1::uuid[])`,
          [ids],
        )
      : [];
    return new Map(
      legs.map((l) => [
        l.id,
        rows
          .filter((r) => r.movementId === l.movementId)
          .map((r) => ({ productId: r.productId, quantity: r.quantity })),
      ]),
    );
  }

  /** Par produit : demandé, réservé (parts en cours), remis, reste à trouver. */
  private async balance(
    transfer: TransferRow,
    legs: LegRow[],
    m: EntityManager = this.db.manager,
  ) {
    const given = await this.given(legs, m);
    return transfer.lines.map((line) => {
      const reserved = legs
        .filter((l) => ACTIVE.includes(l.status))
        .reduce(
          (s, l) =>
            s +
            (l.lines.find((x) => x.productId === line.productId)?.quantity ??
              0),
          0,
        );
      const done = legs
        .filter((l) => l.status === TransferLegStatus.Done)
        .reduce(
          (s, l) =>
            s +
            (given.get(l.id)?.find((x) => x.productId === line.productId)
              ?.quantity ?? 0),
          0,
        );
      return {
        productId: line.productId,
        requested: line.quantity,
        reserved: round(reserved),
        given: round(done),
        remaining: Math.max(0, round(line.quantity - reserved - done)),
      };
    });
  }

  /** Statut recalculé après chaque changement (sauf demande close ou expirée). */
  private async refresh(
    transferId: string,
    m: EntityManager = this.db.manager,
  ) {
    const transfer = await this.transfer(transferId, m);
    if (!OPEN.includes(transfer.status)) return transfer.status;
    const legs = await this.legs(transferId, m);
    const balance = await this.balance(transfer, legs, m);
    const left = balance.some((b) => b.remaining > 0);
    const active = legs.some((l) => ACTIVE.includes(l.status));
    const status = left
      ? TransferStatus.Open
      : active
        ? TransferStatus.Covered
        : TransferStatus.Done;
    if (status !== transfer.status)
      await m.query(
        `UPDATE van_transfers SET status = $2, updated_at = now(),
                closed_at = CASE WHEN $2 = 'done' THEN now() ELSE closed_at END
         WHERE id = $1`,
        [transferId, status],
      );
    return status;
  }

  // ------------------------------------------------------------ lecture

  /**
   * Agent : ses demandes et celles où il a pris une part ; chef : celles qui concernent son
   * équipe ; administrateur : toutes.
   */
  async list(user: AuthUser, q: TransfersQuery) {
    const scope =
      user.role === Role.Agent ? [user.id] : await this.access.agentScope(user);
    const rows = await this.db.manager.query<TransferRow[]>(
      `SELECT ${T_SELECT}
       WHERE ($1::uuid[] IS NULL OR t.requester_id = ANY($1::uuid[])
              OR EXISTS (SELECT 1 FROM van_transfer_legs l WHERE l.transfer_id = t.id
                         AND l.giver_id = ANY($1::uuid[])))
         AND (CASE WHEN $2 = 'open' THEN t.status = ANY($3::text[])
                   ELSE t.created_at > now() - interval '30 days' END)
       ORDER BY t.created_at DESC LIMIT 100`,
      [scope, q.state ?? 'open', OPEN],
    );
    return Promise.all(rows.map((r) => this.view(user, r)));
  }

  /**
   * Historique des dépannages de l'agent : ses demandes (reçus) et celles où il a pris une
   * part (donnés), filtrés par période (date de la demande), état et produit. Les totaux sont
   * les quantités réellement remises sur la période, reçues et données, par produit.
   */
  async history(
    user: AuthUser,
    q: {
      from?: string;
      to?: string;
      productId?: string;
      status?: string;
      direction?: 'received' | 'given';
      page: number;
      limit: number;
    },
  ) {
    const tz = (await this.access.settings()).timezone;
    const params: unknown[] = [user.id];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    // Fuseau ajouté aux paramètres seulement s'il sert (une période est demandée).
    let tzRef: string | undefined;
    const day = (col: string) =>
      `(${col} AT TIME ZONE ${(tzRef ??= p(tz))})::date`;
    const asGiver = `EXISTS (SELECT 1 FROM van_transfer_legs l WHERE l.transfer_id = t.id AND l.giver_id = $1)`;
    const where = [
      q.direction === 'received'
        ? `t.requester_id = $1`
        : q.direction === 'given'
          ? asGiver
          : `(t.requester_id = $1 OR ${asGiver})`,
    ];
    if (q.status === 'open') where.push(`t.status = ANY(${p(OPEN)}::text[])`);
    else if (q.status === 'finished')
      where.push(`NOT t.status = ANY(${p(OPEN)}::text[])`);
    if (q.productId)
      where.push(
        `t.lines @> jsonb_build_array(jsonb_build_object('productId', ${p(q.productId)}::text))`,
      );
    const period = (col: string) =>
      [
        q.from ? `${day(col)} >= ${p(q.from.slice(0, 10))}::date` : null,
        q.to ? `${day(col)} <= ${p(q.to.slice(0, 10))}::date` : null,
      ].filter((x): x is string => !!x);
    where.push(...period('t.created_at'));
    const w = where.join(' AND ');
    const filterParams = [...params];
    const [{ total }] = await this.db.manager.query<{ total: number }[]>(
      `SELECT count(*)::int AS total FROM van_transfers t WHERE ${w}`,
      params,
    );
    const rows = await this.db.manager.query<TransferRow[]>(
      `SELECT ${T_SELECT} WHERE ${w}
       ORDER BY t.created_at DESC
       LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    const items = await Promise.all(
      rows.map(async (r) => ({
        ...(await this.view(user, r)),
        direction: r.requesterId === user.id ? 'received' : 'given',
      })),
    );

    // Quantités remises (code scanné) sur la période : reçues sur mes demandes, données par moi.
    const sParams: unknown[] = [user.id];
    const sp = (v: unknown) => {
      sParams.push(v);
      return `$${sParams.length}`;
    };
    let sTz: string | undefined;
    const sDay = (col: string) =>
      `(${col} AT TIME ZONE ${(sTz ??= sp(tz))})::date`;
    const sWhere = [
      `mv.kind = 'transfer'`,
      `mv.status = 'done'`,
      q.direction === 'received'
        ? `t.requester_id = $1`
        : q.direction === 'given'
          ? `g.giver_id = $1`
          : `(t.requester_id = $1 OR g.giver_id = $1)`,
    ];
    if (q.from)
      sWhere.push(
        `${sDay('mv.occurred_at')} >= ${sp(q.from.slice(0, 10))}::date`,
      );
    if (q.to)
      sWhere.push(
        `${sDay('mv.occurred_at')} <= ${sp(q.to.slice(0, 10))}::date`,
      );
    if (q.productId) sWhere.push(`ml.product_id = ${sp(q.productId)}`);
    const products = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT ml.product_id AS "productId", trim(p.name || ' ' || coalesce(p.format, '')) AS name,
              p.unit, p.packagings,
              coalesce(sum(ml.quantity) FILTER (WHERE t.requester_id = $1), 0)::float8 AS received,
              coalesce(sum(ml.quantity) FILTER (WHERE g.giver_id = $1), 0)::float8 AS given
       FROM van_transfer_legs g
       JOIN van_transfers t ON t.id = g.transfer_id
       JOIN stock_movements mv ON mv.id = g.movement_id
       JOIN stock_movement_lines ml ON ml.movement_id = mv.id
       JOIN products p ON p.id = ml.product_id
       WHERE ${sWhere.join(' AND ')}
       GROUP BY ml.product_id, p.name, p.format, p.unit, p.packagings
       ORDER BY name`,
      sParams,
    );
    const [counts] = await this.db.manager.query<
      { requested: number; helped: number }[]
    >(
      `SELECT (count(*) FILTER (WHERE t.requester_id = $1))::int AS requested,
              (count(*) FILTER (WHERE t.requester_id <> $1))::int AS helped
       FROM van_transfers t WHERE ${w}`,
      filterParams,
    );
    return {
      items,
      total,
      page: q.page,
      limit: q.limit,
      summary: { ...counts, products },
    };
  }

  /**
   * Demandes de collègues que je peux aider (agent) : encore ouvertes, avec au moins un
   * produit que j'ai ; d'abord dans mon équipe, les autres équipes après l'élargissement.
   */
  async nearby(user: AuthUser) {
    const van = await this.stock.requireVan(user);
    const me = await this.access.getAgent(user.id);
    const teams = await this.teamsMatter();
    const rows = await this.db.manager.query<TransferRow[]>(
      `SELECT ${T_SELECT} WHERE t.status = 'open' AND t.requester_id <> $1
       ORDER BY t.created_at DESC LIMIT 50`,
      [user.id],
    );
    const positions = await this.live.all(this.db.tenantId);
    const here = positions.get(user.id);
    const out = [];
    for (const r of rows) {
      const sameTeam =
        !teams || (r.requesterGroupId ?? null) === (me.groupId ?? null);
      if (!sameTeam && !r.widenedAt) continue;
      const legs = await this.legs(r.id);
      const balance = await this.balance(r, legs);
      const open = balance.filter((b) => b.remaining > 0);
      const stock = await this.stock.quantities(
        van.id,
        open.map((b) => b.productId),
      );
      if (!open.some((b) => (stock.get(b.productId) ?? 0) > 0)) continue;
      const there = positions.get(r.requesterId);
      out.push({
        ...(await this.view(user, r)),
        needsApproval: !sameTeam,
        myStock: Object.fromEntries(
          open.map((b) => [b.productId, stock.get(b.productId) ?? 0]),
        ),
        distanceM:
          here && there
            ? Math.round(
                haversine(
                  { lat: here.lat, lng: here.lng },
                  { lat: there.lat, lng: there.lng },
                ),
              )
            : null,
      });
    }
    return out.sort(
      (a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity),
    );
  }

  async get(user: AuthUser, id: string) {
    const transfer = await this.transfer(id);
    await this.assertVisible(user, transfer);
    return this.view(user, transfer);
  }

  private async assertVisible(user: AuthUser, t: TransferRow) {
    if (user.role === Role.Admin) return;
    const legs = await this.legs(t.id);
    const people = [t.requesterId, ...legs.map((l) => l.giverId)];
    if (user.role === Role.Agent) {
      if (people.includes(user.id)) return;
      // Un collègue qui peut aider voit la demande ouverte (notification, liste « autour »).
      if (t.status === TransferStatus.Open) {
        const me = await this.access.getAgent(user.id);
        const sameTeam =
          !(await this.teamsMatter()) ||
          (t.requesterGroupId ?? null) === (me.groupId ?? null);
        if (sameTeam || t.widenedAt) return;
      }
      throw notFound('Dépannage');
    }
    const scope = await this.access.agentScope(user);
    if (scope && !people.some((p) => scope.includes(p)))
      throw notFound('Dépannage');
  }

  /** Vue d'une demande : produits nommés, quantités, parts ; le code, au demandeur seul. */
  private async view(user: AuthUser, t: TransferRow) {
    const legs = await this.legs(t.id);
    const balance = await this.balance(t, legs);
    const given = await this.given(legs);
    const names = await this.productNames(t.lines.map((l) => l.productId));
    const { token, notified, requesterGroupId, ...rest } = t;
    void notified;
    void requesterGroupId;
    return {
      ...rest,
      statusLabel: TRANSFER_STATUS_LABELS[t.status],
      lines: balance.map((b) => ({
        ...b,
        name: names.get(b.productId) ?? 'Produit',
      })),
      legs: legs.map((l) => ({
        id: l.id,
        giverId: l.giverId,
        giverName: l.giverName,
        status: l.status,
        statusLabel: TRANSFER_LEG_STATUS_LABELS[l.status],
        crossTeam: l.crossTeam,
        lines: l.lines.map((x) => ({
          ...x,
          name: names.get(x.productId) ?? 'Produit',
        })),
        given: given.get(l.id) ?? [],
        acceptedAt: l.acceptedAt,
        /** Fin de la réservation (libérée ensuite si rien n'est remis) */
        expiresAt:
          l.status === TransferLegStatus.Accepted && l.acceptedAt
            ? new Date(
                new Date(l.acceptedAt).getTime() + RESERVATION_MIN * 60_000,
              )
            : null,
        doneAt: l.doneAt,
        decisionNote: l.decisionNote,
        releaseReason: l.releaseReason,
      })),
      // Code à montrer aux collègues (QR) : au demandeur seul, tant que la demande est ouverte.
      token:
        user.id === t.requesterId && OPEN.includes(t.status) ? token : null,
    };
  }

  // ------------------------------------------------------------ parts

  /**
   * Un collègue prend une part : au plus ce qui reste à trouver et ce qu'il a dans son camion.
   * Même équipe : réservée tout de suite (1 h) ; autre équipe : attend l'accord de son chef.
   */
  async accept(user: AuthUser, id: string, dto: AcceptTransferDto) {
    const m = this.db.manager;
    await m.query(`SELECT 1 FROM van_transfers WHERE id = $1 FOR UPDATE`, [id]);
    const transfer = await this.transfer(id);
    await this.assertVisible(user, transfer);
    if (transfer.requesterId === user.id)
      throw badRequest(
        'TRANSFER_SELF',
        'Vous ne pouvez pas vous dépanner vous-même',
      );
    if (transfer.status !== TransferStatus.Open)
      throw conflict(
        'TRANSFER_NOT_OPEN',
        transfer.status === TransferStatus.Covered
          ? 'Tout est déjà réservé par des collègues'
          : 'Cette demande est terminée',
      );
    const legs = await this.legs(id);
    if (legs.some((l) => l.giverId === user.id && ACTIVE.includes(l.status)))
      throw conflict(
        'ALREADY_TAKEN',
        'Vous avez déjà une part en cours dans cette demande',
      );
    const van = await this.stock.requireVan(user);
    const lines = await this.stock.validLines(dto.lines);
    const balance = await this.balance(transfer, legs);
    const stock = await this.stock.quantities(
      van.id,
      lines.map((l) => l.productId),
    );
    const names = await this.productNames(lines.map((l) => l.productId));
    for (const l of lines) {
      const b = balance.find((x) => x.productId === l.productId);
      if (!b)
        throw badRequest(
          'UNKNOWN_LINE',
          'Un produit proposé ne fait pas partie de la demande',
        );
      if (l.quantity > b.remaining)
        throw badRequest(
          'MORE_THAN_NEEDED',
          `Il ne reste que ${b.remaining} « ${names.get(l.productId)} » à trouver`,
        );
      if (l.quantity > (stock.get(l.productId) ?? 0))
        throw badRequest(
          'INSUFFICIENT_STOCK',
          `Stock de votre camion insuffisant pour « ${names.get(l.productId)} » : ${Math.max(0, stock.get(l.productId) ?? 0)} disponible(s)`,
        );
    }
    const me = await this.access.getAgent(user.id);
    const crossTeam =
      (await this.teamsMatter()) &&
      (me.groupId ?? null) !== (transfer.requesterGroupId ?? null);
    const [{ id: legId }] = await m.query<{ id: string }[]>(
      `INSERT INTO van_transfer_legs (tenant_id, transfer_id, giver_id, giver_van_id, status,
                                      cross_team, lines, accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CASE WHEN $5 = 'accepted' THEN now() END)
       RETURNING id`,
      [
        this.db.tenantId,
        id,
        user.id,
        van.id,
        crossTeam ? TransferLegStatus.Approval : TransferLegStatus.Accepted,
        crossTeam,
        JSON.stringify(lines),
      ],
    );
    await this.refresh(id);
    const summary = await this.summary(lines);
    const who = `${me.firstName} ${me.lastName}`;
    if (crossTeam) {
      const approvers = await this.access.approverIds(
        me,
        await this.access.settings(),
      );
      await this.notifications.notify(approvers, {
        type: 'transfer.approval',
        title: 'Dépannage à valider',
        body: `${who} propose de dépanner ${transfer.requesterName} (autre équipe) : ${summary}`,
        data: { transferId: id, legId },
      });
    }
    await this.notifications.notify([transfer.requesterId], {
      type: 'transfer.accepted',
      title: crossTeam ? 'Proposition de dépannage' : 'Dépannage en route',
      body: crossTeam
        ? `${who} (autre équipe) propose : ${summary}. En attente de l'accord de son chef.`
        : `${who} vient vous dépanner : ${summary}. Montrez-lui votre code à son arrivée.`,
      data: { transferId: id, legId },
    });
    return this.get(user, id);
  }

  /** Part d'un collègue d'une autre équipe : son chef (ou un administrateur) valide ou refuse. */
  async decideLeg(
    user: AuthUser,
    legId: string,
    approve: boolean,
    note?: string,
  ) {
    const leg = await this.leg(legId);
    if (leg.status !== TransferLegStatus.Approval)
      throw conflict(
        'LEG_NOT_PENDING',
        'Cette part n’attend pas de validation',
      );
    if (user.role === Role.Agent)
      throw forbidden('Le chef du collègue valide cette part');
    if (user.role === Role.TeamLead)
      await this.access.assertCanManageAgent(user, leg.giverId);
    const transfer = await this.transfer(leg.transferId);
    if (approve && !OPEN.includes(transfer.status))
      throw conflict('TRANSFER_CLOSED', 'Cette demande est déjà terminée');
    await this.db.manager.query(
      `UPDATE van_transfer_legs SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
              accepted_at = CASE WHEN $2 = 'accepted' THEN now() ELSE accepted_at END
       WHERE id = $1`,
      [
        legId,
        approve ? TransferLegStatus.Accepted : TransferLegStatus.Rejected,
        user.id,
        note || null,
      ],
    );
    await this.refresh(leg.transferId);
    await this.notifications.notify([leg.giverId], {
      type: approve ? 'transfer.leg_approved' : 'transfer.leg_rejected',
      title: approve ? 'Dépannage validé' : 'Dépannage refusé',
      body: approve
        ? `Votre chef a validé : allez dépanner ${transfer.requesterName}.`
        : `Votre chef a refusé votre dépannage pour ${transfer.requesterName}${note ? ` : ${note}` : ''}.`,
      data: { transferId: leg.transferId, legId },
    });
    await this.notifications.notify([transfer.requesterId], {
      type: approve ? 'transfer.leg_approved' : 'transfer.leg_rejected',
      title: approve ? 'Dépannage en route' : 'Proposition refusée',
      body: approve
        ? `${leg.giverName} vient vous dépanner. Montrez-lui votre code à son arrivée.`
        : `La proposition de ${leg.giverName} est refusée par son chef : la demande reste ouverte.`,
      data: { transferId: leg.transferId, legId },
    });
    return this.get(user, leg.transferId);
  }

  /** Le collègue abandonne sa part : elle redevient disponible pour les autres. */
  async releaseLeg(user: AuthUser, legId: string, note?: string) {
    const leg = await this.leg(legId);
    if (leg.giverId !== user.id)
      throw forbidden('Seul le collègue abandonne sa part');
    if (!ACTIVE.includes(leg.status))
      throw conflict('LEG_CLOSED', 'Cette part est déjà terminée');
    await this.release(
      leg,
      note ? `Abandonnée : ${note}` : 'Abandonnée par le collègue',
    );
    const transfer = await this.transfer(leg.transferId);
    await this.notifications.notify([transfer.requesterId], {
      type: 'transfer.leg_released',
      title: 'Dépannage abandonné',
      body: `${leg.giverName} ne viendra pas${note ? ` : ${note}` : ''}. Votre demande reste ouverte aux autres collègues.`,
      data: { transferId: leg.transferId, legId },
    });
    return this.get(user, leg.transferId);
  }

  private async release(
    leg: { id: string; transferId: string },
    reason: string,
  ) {
    await this.db.manager.query(
      `UPDATE van_transfer_legs SET status = 'released', release_reason = $2 WHERE id = $1`,
      [leg.id, reason],
    );
    await this.refresh(leg.transferId);
  }

  /** Le demandeur clôt sa demande (« j'ai ce qu'il me faut ») : les parts en cours sont libérées. */
  async close(user: AuthUser, id: string) {
    const transfer = await this.transfer(id);
    if (transfer.requesterId !== user.id)
      throw forbidden('Seul le demandeur clôt sa demande');
    if (!OPEN.includes(transfer.status))
      throw conflict('TRANSFER_CLOSED', 'Cette demande est déjà terminée');
    await this.finish(
      transfer,
      TransferStatus.Closed,
      'Demande close par le demandeur',
    );
    return this.get(user, id);
  }

  private async finish(
    transfer: TransferRow,
    status: TransferStatus,
    reason: string,
  ) {
    const legs = await this.legs(transfer.id);
    const active = legs.filter((l) => ACTIVE.includes(l.status));
    await this.db.manager.query(
      `UPDATE van_transfer_legs SET status = 'released', release_reason = $2
       WHERE transfer_id = $1 AND status = ANY($3::text[])`,
      [transfer.id, reason, ACTIVE],
    );
    await this.db.manager.query(
      `UPDATE van_transfers SET status = $2, closed_at = now(), updated_at = now() WHERE id = $1`,
      [transfer.id, status],
    );
    if (active.length)
      await this.notifications.notify(
        active.map((l) => l.giverId),
        {
          type: 'transfer.closed',
          title: 'Dépannage annulé',
          body: `${transfer.requesterName} n’a plus besoin de votre dépannage.`,
          data: { transferId: transfer.id },
        },
      );
  }

  // ------------------------------------------------------------ remise sur place

  /**
   * Remise : le collègue a scanné le code du demandeur (preuve qu'ils sont ensemble) et
   * déclare ce qu'il donne, au plus sa part réservée. Le stock sort de son camion et entre
   * dans celui du demandeur. Idempotente (clientId du téléphone du collègue).
   */
  async handover(user: AuthUser, dto: TransferHandoverDto) {
    const m = this.db.manager;
    const [already] = await m.query<{ transferId: string }[]>(
      `SELECT l.transfer_id AS "transferId" FROM van_transfer_legs l
       JOIN stock_movements mv ON mv.id = l.movement_id
       WHERE mv.created_by = $1 AND mv.client_id = $2`,
      [user.id, dto.clientId],
    );
    if (already) return this.get(user, already.transferId);
    const [found] = await m.query<{ id: string }[]>(
      `SELECT id FROM van_transfers WHERE token = $1 FOR UPDATE`,
      [dto.token],
    );
    if (!found)
      throw notFound(
        'Dépannage (code inconnu : faites rescanner le code du collègue)',
      );
    const transfer = await this.transfer(found.id);
    if (!OPEN.includes(transfer.status))
      throw conflict('TRANSFER_CLOSED', 'Cette demande est déjà terminée');
    const legs = await this.legs(transfer.id);
    const mine = legs.filter(
      (l) => l.giverId === user.id && ACTIVE.includes(l.status),
    );
    if (!mine.length)
      throw forbidden(
        'Prenez d’abord votre part dans cette demande de dépannage, puis scannez le code',
      );
    const leg = mine[0];
    if (leg.status === TransferLegStatus.Approval)
      throw conflict(
        'LEG_NOT_APPROVED',
        'Votre part attend encore l’accord de votre chef',
      );
    const giverVan = await this.stock.requireVan(user);
    const requesterVan = await this.stock.vanOf(transfer.requesterId);
    if (!requesterVan)
      throw badRequest(
        'REQUESTER_NO_VAN',
        `${transfer.requesterName} n’a plus de camion affecté`,
      );
    const lines = await this.stock.validLines(dto.lines);
    const names = await this.productNames(lines.map((l) => l.productId));
    for (const l of lines) {
      const reserved = leg.lines.find(
        (x) => x.productId === l.productId,
      )?.quantity;
      if (reserved == null)
        throw badRequest(
          'UNKNOWN_LINE',
          'Un produit remis ne fait pas partie de votre part',
        );
      if (l.quantity > reserved)
        throw badRequest(
          'MORE_THAN_RESERVED',
          `Votre part de « ${names.get(l.productId)} » est de ${reserved}`,
        );
    }
    const stock = await this.stock.quantities(
      giverVan.id,
      lines.map((l) => l.productId),
    );
    const short = lines.find((l) => (stock.get(l.productId) ?? 0) < l.quantity);
    if (short)
      throw badRequest(
        'INSUFFICIENT_STOCK',
        `Stock de votre camion insuffisant pour « ${names.get(short.productId)} » : ${Math.max(0, stock.get(short.productId) ?? 0)} disponible(s)`,
      );
    const movementId = await this.stock.insertMovement(m, {
      kind: StockMovementKind.Transfer,
      from: giverVan.id,
      to: requesterVan.id,
      clientId: dto.clientId,
      note: `Dépannage de ${leg.giverName} pour ${transfer.requesterName}`,
      createdBy: user.id,
      lines,
    });
    await this.stock.apply(
      m,
      giverVan.id,
      lines.map((l) => ({ productId: l.productId, quantity: -l.quantity })),
    );
    await this.stock.apply(m, requesterVan.id, lines);
    await m.query(
      `UPDATE van_transfer_legs SET status = 'done', movement_id = $2, done_at = now() WHERE id = $1`,
      [leg.id, movementId],
    );
    const status = await this.refresh(transfer.id);
    const less = leg.lines.some(
      (r) =>
        (lines.find((l) => l.productId === r.productId)?.quantity ?? 0) <
        r.quantity,
    );
    await this.notifications.notify([transfer.requesterId], {
      type: 'transfer.done',
      title: 'Dépannage reçu',
      body:
        `${leg.giverName} vous a remis : ${await this.summary(lines)}. Votre stock est à jour.` +
        (less
          ? ' Moins que prévu : le reste est de nouveau proposé aux collègues.'
          : '') +
        (status === TransferStatus.Done ? ' Votre demande est complète.' : ''),
      data: { transferId: transfer.id, legId: leg.id },
    });
    return this.get(user, transfer.id);
  }

  // ------------------------------------------------------------ chaque minute

  /**
   * Planificateur (par structure) : parts réservées depuis plus d'1 h libérées, demandes sans
   * réponse depuis 10 min élargies à tous ceux qui ont un produit, demandes de plus de 4 h
   * fermées. Rend ce qui a été fait.
   */
  async sweep() {
    const m = this.db.manager;
    const stale = await m.query<
      { id: string; transferId: string; giverId: string; giverName: string }[]
    >(
      `SELECT l.id, l.transfer_id AS "transferId", l.giver_id AS "giverId",
              trim(g.first_name || ' ' || g.last_name) AS "giverName"
       FROM van_transfer_legs l JOIN users g ON g.id = l.giver_id
       JOIN van_transfers t ON t.id = l.transfer_id
       WHERE l.status = 'accepted' AND t.status = ANY($1::text[])
         AND l.accepted_at < now() - make_interval(mins => $2)`,
      [OPEN, RESERVATION_MIN],
    );
    for (const leg of stale) {
      await this.release(
        leg,
        `Délai dépassé (${RESERVATION_MIN} min sans remise)`,
      );
      const transfer = await this.transfer(leg.transferId);
      await this.notifications.notify([leg.giverId], {
        type: 'transfer.leg_released',
        title: 'Réservation libérée',
        body: `Votre part pour ${transfer.requesterName} est libérée : 1 h sans remise.`,
        data: { transferId: leg.transferId, legId: leg.id },
      });
      await this.notifications.notify([transfer.requesterId], {
        type: 'transfer.leg_released',
        title: 'Réservation libérée',
        body: `${leg.giverName} n’est pas venu dans l’heure : votre demande est de nouveau proposée aux collègues.`,
        data: { transferId: leg.transferId, legId: leg.id },
      });
    }

    const toWiden = await m.query<{ id: string }[]>(
      `SELECT id FROM van_transfers WHERE status = 'open' AND widened_at IS NULL
         AND created_at < now() - make_interval(mins => $1)`,
      [WIDEN_AFTER_MIN],
    );
    for (const { id } of toWiden) {
      const transfer = await this.transfer(id);
      const balance = await this.balance(transfer, await this.legs(id));
      const open = balance
        .filter((b) => b.remaining > 0)
        .map((b) => ({ productId: b.productId, quantity: b.remaining }));
      await m.query(
        `UPDATE van_transfers SET widened_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      );
      await this.notifyCandidates(
        transfer,
        await this.candidates(transfer, open),
        open,
      );
    }

    const toExpire = await m.query<{ id: string }[]>(
      `SELECT id FROM van_transfers WHERE status = ANY($1::text[])
         AND created_at < now() - make_interval(hours => $2)`,
      [OPEN, EXPIRE_AFTER_H],
    );
    for (const { id } of toExpire) {
      const transfer = await this.transfer(id);
      await this.finish(
        transfer,
        TransferStatus.Expired,
        `Demande expirée (${EXPIRE_AFTER_H} h)`,
      );
      await this.notifications.notify([transfer.requesterId], {
        type: 'transfer.expired',
        title: 'Demande de dépannage expirée',
        body: `Votre demande de dépannage s’est fermée après ${EXPIRE_AFTER_H} h.`,
        data: { transferId: id },
      });
    }
    if (stale.length || toWiden.length || toExpire.length) {
      const tenantId = this.db.tenantId;
      this.db.afterCommit(() => this.realtime.sync(tenantId, 'van-sales'));
    }
    return {
      released: stale.length,
      widened: toWiden.length,
      expired: toExpire.length,
    };
  }
}

function formatDistance(m: number) {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}
