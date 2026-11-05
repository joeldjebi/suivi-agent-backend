import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  Role,
  STOCK_MOVEMENT_KIND_LABELS,
  StockLocationKind,
  StockMovementKind,
  StockMovementStatus,
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
import type {
  ConfirmMovementDto,
  CreateLocationDto,
  InventoryDto,
  LoadDto,
  LossDto,
  MovementsQuery,
  ReceiptDto,
  StockLineDto,
  UnloadDto,
  UpdateLocationDto,
} from './van-sales.dto';

export interface StockLocation {
  id: string;
  kind: StockLocationKind;
  name: string;
  plate: string | null;
  agentId: string | null;
  agentName: string | null;
  isActive: boolean;
}

/** Ligne d'un mouvement : quantité signée par emplacement (unités de base). */
export interface StockDelta {
  productId: string;
  quantity: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

const LOCATION_SELECT = `
  sl.id, sl.kind, sl.name, sl.plate, sl.agent_id AS "agentId",
  nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS "agentName",
  sl.is_active AS "isActive"
  FROM stock_locations sl LEFT JOIN users u ON u.id = sl.agent_id`;

/**
 * Stock de la vente en camionnette : dépôts et camions, quantités par produit, et chaque
 * entrée ou sortie enregistrée comme un mouvement. Un chargement (dépôt → camion) attend la
 * confirmation de l'agent ; un retour (camion → dépôt), celle d'un responsable.
 */
@Injectable()
export class StockService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Chaque requête est déjà une transaction (RLS) : tout ce bloc est validé ou annulé ensemble. */
  private tx<T>(fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return fn(this.db.manager);
  }

  // ------------------------------------------------------------ emplacements

  /** Responsables : tous ; agent : son camion et les dépôts (pour ses retours). */
  async locations(user: AuthUser): Promise<StockLocation[]> {
    const agentOnly = user.role === Role.Agent;
    return this.db.manager.query<StockLocation[]>(
      `SELECT ${LOCATION_SELECT}
       WHERE ($1::uuid IS NULL OR (sl.is_active AND (sl.kind = 'depot' OR sl.agent_id = $1)))
       ORDER BY sl.is_active DESC, sl.kind, lower(sl.name)`,
      [agentOnly ? user.id : null],
    );
  }

  async location(id: string): Promise<StockLocation> {
    const [row] = await this.db.manager.query<StockLocation[]>(
      `SELECT ${LOCATION_SELECT} WHERE sl.id = $1`,
      [id],
    );
    if (!row) throw notFound('Dépôt ou camion');
    return row;
  }

  /** Le camion actif de l'agent, ou null. */
  async vanOf(agentId: string): Promise<StockLocation | null> {
    const [row] = await this.db.manager.query<StockLocation[]>(
      `SELECT ${LOCATION_SELECT} WHERE sl.agent_id = $1 AND sl.is_active`,
      [agentId],
    );
    return row ?? null;
  }

  async requireVan(user: AuthUser): Promise<StockLocation> {
    const van = await this.vanOf(user.id);
    if (!van)
      throw badRequest(
        'NO_VAN',
        'Aucun camion ne vous est affecté : demandez à votre responsable',
      );
    return van;
  }

  async createLocation(dto: CreateLocationDto) {
    await this.assertNameFree(dto.name);
    if (dto.kind === StockLocationKind.Depot && dto.agentId)
      throw badRequest(
        'DEPOT_WITHOUT_AGENT',
        'Seul un camion est affecté à un agent',
      );
    if (dto.agentId) await this.assertAgentFree(dto.agentId);
    const [{ id }] = await this.db.manager.query<{ id: string }[]>(
      `INSERT INTO stock_locations (tenant_id, kind, name, plate, agent_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        this.db.tenantId,
        dto.kind,
        dto.name,
        dto.plate || null,
        dto.agentId ?? null,
      ],
    );
    return this.location(id);
  }

  async updateLocation(id: string, dto: UpdateLocationDto) {
    const location = await this.location(id);
    if (dto.name !== undefined && dto.name !== location.name)
      await this.assertNameFree(dto.name, id);
    if (dto.agentId) {
      if (location.kind !== StockLocationKind.Van)
        throw badRequest(
          'DEPOT_WITHOUT_AGENT',
          'Seul un camion est affecté à un agent',
        );
      if (dto.agentId !== location.agentId)
        await this.assertAgentFree(dto.agentId, id);
    }
    if (dto.isActive === false && location.isActive) {
      const [{ pending }] = await this.db.manager.query<{ pending: number }[]>(
        `SELECT count(*)::int AS pending FROM stock_movements
         WHERE status = 'pending' AND (from_location_id = $1 OR to_location_id = $1)`,
        [id],
      );
      if (pending)
        throw conflict(
          'PENDING_MOVEMENTS',
          'Des chargements ou retours attendent une confirmation : traitez-les d’abord',
        );
    }
    if (dto.isActive === true && !location.isActive && location.agentId)
      await this.assertAgentFree(location.agentId, id);
    await this.db.manager.query(
      `UPDATE stock_locations SET
         name = coalesce($2, name),
         plate = CASE WHEN $3::boolean THEN $4 ELSE plate END,
         agent_id = CASE WHEN $5::boolean THEN $6::uuid ELSE agent_id END,
         is_active = coalesce($7, is_active),
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        dto.name ?? null,
        dto.plate !== undefined,
        dto.plate || null,
        dto.agentId !== undefined,
        dto.agentId ?? null,
        dto.isActive ?? null,
      ],
    );
    return this.location(id);
  }

  private async assertNameFree(name: string, except?: string) {
    const [taken] = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM stock_locations WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2`,
      [name, except ?? null],
    );
    if (taken) throw conflict('LOCATION_EXISTS', `« ${name} » existe déjà`);
  }

  private async assertAgentFree(agentId: string, except?: string) {
    const agent = await this.access.getAgent(agentId);
    if (agent.role !== Role.Agent)
      throw badRequest('NOT_AN_AGENT', 'Un camion est affecté à un agent');
    const [taken] = await this.db.manager.query<{ name: string }[]>(
      `SELECT name FROM stock_locations
       WHERE agent_id = $1 AND is_active AND id IS DISTINCT FROM $2`,
      [agentId, except ?? null],
    );
    if (taken)
      throw conflict(
        'AGENT_HAS_VAN',
        `Cet agent a déjà un camion : « ${taken.name} »`,
      );
  }

  /** Le chef gère les camions de ses agents ; l'administrateur, tous. */
  private async assertManages(user: AuthUser, location: StockLocation) {
    if (user.role === Role.Admin) return;
    if (user.role === Role.TeamLead) {
      if (location.kind === StockLocationKind.Depot || !location.agentId)
        return;
      const scope = await this.access.agentScope(user);
      if (!scope || scope.includes(location.agentId)) return;
    }
    throw forbidden('Ce camion n’est pas dans votre périmètre');
  }

  // ------------------------------------------------------------ niveaux

  /**
   * Stock par produit : d'un emplacement (avec `locationId`), ou de tous ceux visibles
   * (tableau produits × emplacements). L'agent ne voit que son camion.
   */
  async levels(user: AuthUser, locationId?: string) {
    if (user.role === Role.Agent) {
      const van = await this.requireVan(user);
      if (locationId && locationId !== van.id)
        throw forbidden('Vous ne voyez que le stock de votre camion');
      locationId = van.id;
    }
    const locations = locationId
      ? [await this.location(locationId)]
      : (await this.locations(user)).filter((l) => l.isActive);
    const ids = locations.map((l) => l.id);
    const products = await this.db.manager.query<
      {
        id: string;
        name: string;
        format: string | null;
        category: string | null;
        unit: string;
        packagings: unknown;
        quantities: Record<string, number>;
        total: number;
      }[]
    >(
      `SELECT p.id, p.name, p.format, p.category, p.unit, p.packagings,
              coalesce(jsonb_object_agg(s.location_id, s.quantity::float8)
                FILTER (WHERE s.location_id IS NOT NULL), '{}') AS quantities,
              coalesce(sum(s.quantity), 0)::float8 AS total
       FROM products p
       LEFT JOIN stock_levels s ON s.product_id = p.id AND s.location_id = ANY($1::uuid[])
       WHERE p.own AND (p.is_active OR s.quantity <> 0)
       GROUP BY p.id
       ORDER BY p.category NULLS LAST, p.name`,
      [ids],
    );
    return { locations, products };
  }

  // ------------------------------------------------------------ mouvements

  /** Produits valides (les nôtres, actifs) ; quantités additionnées par produit. */
  async validLines(lines: StockLineDto[]): Promise<StockDelta[]> {
    const sums = new Map<string, number>();
    for (const l of lines)
      sums.set(l.productId, round((sums.get(l.productId) ?? 0) + l.quantity));
    const ids = [...sums.keys()];
    const found = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM products WHERE id = ANY($1::uuid[]) AND own AND is_active`,
      [ids],
    );
    if (found.length !== ids.length)
      throw badRequest(
        'PRODUCT_NOT_STOCKED',
        'Seuls les produits actifs de la structure ont un stock',
      );
    return [...sums].map(([productId, quantity]) => ({ productId, quantity }));
  }

  /** Ajoute (ou retire) des quantités au stock d'un emplacement ; rend les niveaux obtenus. */
  async apply(
    t: EntityManager,
    locationId: string,
    deltas: StockDelta[],
  ): Promise<{ productId: string; quantity: number }[]> {
    const result: { productId: string; quantity: number }[] = [];
    for (const d of deltas) {
      if (!d.quantity) continue;
      const [row] = await t.query<{ quantity: number }[]>(
        `INSERT INTO stock_levels (tenant_id, location_id, product_id, quantity)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (location_id, product_id)
         DO UPDATE SET quantity = stock_levels.quantity + excluded.quantity, updated_at = now()
         RETURNING quantity::float8 AS quantity`,
        [this.db.tenantId, locationId, d.productId, d.quantity],
      );
      result.push({ productId: d.productId, quantity: row.quantity });
    }
    return result;
  }

  /** Quantités actuelles d'un emplacement pour ces produits. */
  async quantities(
    locationId: string,
    productIds: string[],
    m: EntityManager = this.db.manager,
  ): Promise<Map<string, number>> {
    const rows = await m.query<{ productId: string; quantity: number }[]>(
      `SELECT product_id AS "productId", quantity::float8 AS quantity
       FROM stock_levels WHERE location_id = $1 AND product_id = ANY($2::uuid[])`,
      [locationId, productIds],
    );
    return new Map(rows.map((r) => [r.productId, r.quantity]));
  }

  async insertMovement(
    t: EntityManager,
    mv: {
      kind: StockMovementKind;
      status?: StockMovementStatus;
      from?: string | null;
      to?: string | null;
      orderId?: string | null;
      clientId?: string | null;
      note?: string | null;
      createdBy: string;
      occurredAt?: Date;
      lines: StockDelta[];
    },
  ): Promise<string> {
    const [{ id }] = await t.query<{ id: string }[]>(
      `INSERT INTO stock_movements (tenant_id, kind, status, from_location_id, to_location_id,
                                    order_id, client_id, note, created_by, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        this.db.tenantId,
        mv.kind,
        mv.status ?? StockMovementStatus.Done,
        mv.from ?? null,
        mv.to ?? null,
        mv.orderId ?? null,
        mv.clientId ?? null,
        mv.note || null,
        mv.createdBy,
        mv.occurredAt ?? new Date(),
      ],
    );
    for (const l of mv.lines)
      await t.query(
        `INSERT INTO stock_movement_lines (tenant_id, movement_id, product_id, quantity)
         VALUES ($1, $2, $3, $4)`,
        [this.db.tenantId, id, l.productId, l.quantity],
      );
    return id;
  }

  /** Mouvement déjà enregistré pour ce renvoi du téléphone (idempotence). */
  private async existing(userId: string, clientId: string) {
    const [row] = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM stock_movements WHERE created_by = $1 AND client_id = $2`,
      [userId, clientId],
    );
    return row?.id ?? null;
  }

  private async requireKind(id: string, kind: StockLocationKind) {
    const location = await this.location(id);
    if (location.kind !== kind)
      throw badRequest(
        'WRONG_LOCATION',
        kind === StockLocationKind.Depot
          ? `« ${location.name} » n’est pas un dépôt`
          : `« ${location.name} » n’est pas un camion`,
      );
    if (!location.isActive)
      throw badRequest('LOCATION_INACTIVE', `« ${location.name} » est retiré`);
    return location;
  }

  /** Entrée au dépôt (livraison du fournisseur, production). */
  async receipt(user: AuthUser, dto: ReceiptDto) {
    const depot = await this.requireKind(dto.depotId, StockLocationKind.Depot);
    const lines = await this.validLines(dto.lines);
    const id = await this.tx(async (t) => {
      const id = await this.insertMovement(t, {
        kind: StockMovementKind.Receipt,
        to: depot.id,
        note: dto.note,
        createdBy: user.id,
        lines,
      });
      await this.apply(t, depot.id, lines);
      return id;
    });
    return this.movement(user, id);
  }

  /** Chargement d'un camion : rien ne bouge avant la confirmation de l'agent. */
  async load(user: AuthUser, dto: LoadDto) {
    const depot = await this.requireKind(dto.depotId, StockLocationKind.Depot);
    const van = await this.requireKind(dto.vanId, StockLocationKind.Van);
    await this.assertManages(user, van);
    const lines = await this.validLines(dto.lines);
    // Le dépôt doit avoir de quoi charger (chargements en attente déduits).
    const available = await this.db.manager.query<
      { productId: string; name: string; available: number }[]
    >(
      `SELECT p.id AS "productId", p.name,
              (coalesce((SELECT quantity FROM stock_levels WHERE location_id = $1 AND product_id = p.id), 0)
               - coalesce((SELECT sum(l.quantity) FROM stock_movement_lines l
                           JOIN stock_movements mv ON mv.id = l.movement_id
                           WHERE mv.status = 'pending' AND mv.kind = 'load'
                             AND mv.from_location_id = $1 AND l.product_id = p.id), 0))::float8 AS available
       FROM products p WHERE p.id = ANY($2::uuid[])`,
      [depot.id, lines.map((l) => l.productId)],
    );
    for (const l of lines) {
      const a = available.find((x) => x.productId === l.productId);
      if (a && a.available < l.quantity)
        throw badRequest(
          'INSUFFICIENT_STOCK',
          `Stock insuffisant au dépôt pour « ${a.name} » : ${Math.max(0, a.available)} disponible(s)`,
        );
    }
    const id = await this.insertMovement(this.db.manager, {
      kind: StockMovementKind.Load,
      status: StockMovementStatus.Pending,
      from: depot.id,
      to: van.id,
      note: dto.note,
      createdBy: user.id,
      lines,
    });
    if (van.agentId)
      await this.notifications.notify([van.agentId], {
        type: 'stock.load_pending',
        title: 'Chargement à confirmer',
        body: `${van.name} : ${lines.length} produit${lines.length > 1 ? 's' : ''} depuis ${depot.name}`,
        data: { movementId: id },
      });
    return this.movement(user, id);
  }

  /** Retour au dépôt déclaré par l'agent : rien ne bouge avant la confirmation d'un responsable. */
  async unload(user: AuthUser, dto: UnloadDto) {
    const already = await this.existing(user.id, dto.clientId);
    if (already) return this.movement(user, already);
    const van =
      user.role === Role.Agent
        ? await this.requireVan(user)
        : await this.requireKind(dto.vanId ?? '', StockLocationKind.Van);
    if (user.role === Role.Agent && dto.vanId && dto.vanId !== van.id)
      throw forbidden('Vous ne déchargez que votre camion');
    if (user.role !== Role.Agent) await this.assertManages(user, van);
    const depot = await this.requireKind(dto.depotId, StockLocationKind.Depot);
    const lines = await this.validLines(dto.lines);
    const id = await this.insertMovement(this.db.manager, {
      kind: StockMovementKind.Unload,
      status: StockMovementStatus.Pending,
      from: van.id,
      to: depot.id,
      clientId: dto.clientId,
      note: dto.note,
      createdBy: user.id,
      lines,
    });
    if (van.agentId) {
      const agent = await this.access.getAgent(van.agentId);
      const approvers = await this.access.approverIds(
        agent,
        await this.access.settings(),
      );
      await this.notifications.notify(
        approvers.filter((a) => a !== user.id),
        {
          type: 'stock.unload_pending',
          title: 'Retour au dépôt à confirmer',
          body: `${van.name} → ${depot.name} : ${lines.length} produit${lines.length > 1 ? 's' : ''}`,
          data: { movementId: id },
        },
      );
    }
    return this.movement(user, id);
  }

  /**
   * Confirmation d'un chargement (par l'agent du camion) ou d'un retour (par un responsable),
   * avec les quantités réellement reçues : l'écart éventuel reste visible sur le mouvement.
   */
  async confirm(user: AuthUser, id: string, dto: ConfirmMovementDto) {
    const mv = await this.movement(user, id);
    if (mv.status !== StockMovementStatus.Pending)
      throw conflict('MOVEMENT_NOT_PENDING', 'Ce mouvement est déjà traité');
    if (mv.kind === StockMovementKind.Load) {
      const van = await this.location(mv.toLocationId!);
      if (user.role === Role.Agent && van.agentId !== user.id)
        throw forbidden('Seul l’agent du camion confirme son chargement');
      if (user.role === Role.TeamLead) await this.assertManages(user, van);
    } else if (mv.kind === StockMovementKind.Unload) {
      if (user.role === Role.Agent)
        throw forbidden('Un responsable confirme le retour au dépôt');
      await this.assertManages(user, await this.location(mv.fromLocationId!));
    } else throw conflict('MOVEMENT_NOT_PENDING', 'Rien à confirmer');

    const received = new Map(
      (dto.lines ?? []).map((l) => [l.productId, l.received]),
    );
    for (const productId of received.keys())
      if (!mv.lines.some((l) => l.productId === productId))
        throw badRequest(
          'UNKNOWN_LINE',
          'Un produit confirmé ne fait pas partie du mouvement',
        );
    await this.tx(async (t) => {
      const [locked] = await t.query<{ status: string }[]>(
        `SELECT status FROM stock_movements WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (locked.status !== StockMovementStatus.Pending)
        throw conflict('MOVEMENT_NOT_PENDING', 'Ce mouvement est déjà traité');
      for (const l of mv.lines)
        await t.query(
          `UPDATE stock_movement_lines SET received = $3 WHERE movement_id = $1 AND product_id = $2`,
          [id, l.productId, received.get(l.productId) ?? l.quantity],
        );
      // Parti : la quantité envoyée ; arrivé : la quantité reçue.
      await this.apply(
        t,
        mv.fromLocationId!,
        mv.lines.map((l) => ({
          productId: l.productId,
          quantity: -l.quantity,
        })),
      );
      await this.apply(
        t,
        mv.toLocationId!,
        mv.lines.map((l) => ({
          productId: l.productId,
          quantity: received.get(l.productId) ?? l.quantity,
        })),
      );
      await t.query(
        `UPDATE stock_movements SET status = 'done', confirmed_by = $2, confirmed_at = now(),
                note = CASE WHEN $3::text IS NULL THEN note
                            ELSE concat_ws(' · ', note, $3::text) END
         WHERE id = $1`,
        [id, user.id, dto.note || null],
      );
    });
    return this.movement(user, id);
  }

  /** Chargement ou retour en attente annulé (créateur ou responsable). */
  async cancel(user: AuthUser, id: string, reason: string) {
    const mv = await this.movement(user, id);
    if (mv.status !== StockMovementStatus.Pending)
      throw conflict('MOVEMENT_NOT_PENDING', 'Ce mouvement est déjà traité');
    if (user.role === Role.Agent && mv.createdBy !== user.id)
      throw forbidden('Seul un responsable annule ce mouvement');
    await this.db.manager.query(
      `UPDATE stock_movements SET status = 'cancelled', confirmed_by = $2, confirmed_at = now(),
              note = concat_ws(' · ', note, $3::text)
       WHERE id = $1 AND status = 'pending'`,
      [id, user.id, `Annulé : ${reason}`],
    );
    return this.movement(user, id);
  }

  /** Casse, perte, vol : le stock baisse aussitôt (motif obligatoire). */
  async loss(user: AuthUser, dto: LossDto) {
    const already = await this.existing(user.id, dto.clientId);
    if (already) return this.movement(user, already);
    let location: StockLocation;
    if (user.role === Role.Agent) {
      location = await this.requireVan(user);
      if (dto.locationId && dto.locationId !== location.id)
        throw forbidden('Vous déclarez les pertes de votre camion');
    } else {
      if (!dto.locationId)
        throw badRequest(
          'LOCATION_REQUIRED',
          'Choisissez le dépôt ou le camion',
        );
      location = await this.location(dto.locationId);
      await this.assertManages(user, location);
    }
    const lines = await this.validLines(dto.lines);
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    const id = await this.tx(async (t) => {
      const id = await this.insertMovement(t, {
        kind: StockMovementKind.Loss,
        from: location.id,
        clientId: dto.clientId,
        note: dto.note,
        createdBy: user.id,
        occurredAt,
        lines,
      });
      await this.apply(
        t,
        location.id,
        lines.map((l) => ({ productId: l.productId, quantity: -l.quantity })),
      );
      return id;
    });
    return this.movement(user, id);
  }

  /** Inventaire : chaque quantité comptée remplace le stock ; l'écart est enregistré. */
  async inventory(user: AuthUser, dto: InventoryDto) {
    const location = await this.location(dto.locationId);
    await this.assertManages(user, location);
    const counted = new Map<string, number>();
    for (const l of dto.lines) counted.set(l.productId, l.counted);
    const ids = [...counted.keys()];
    const found = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM products WHERE id = ANY($1::uuid[]) AND own`,
      [ids],
    );
    if (found.length !== ids.length)
      throw badRequest(
        'PRODUCT_NOT_STOCKED',
        'Seuls les produits de la structure ont un stock',
      );
    return this.tx(async (t) => {
      const current = await this.quantities(location.id, ids, t);
      const deltas = ids
        .map((productId) => ({
          productId,
          quantity: round(
            counted.get(productId)! - (current.get(productId) ?? 0),
          ),
        }))
        .filter((d) => d.quantity !== 0);
      if (!deltas.length) return { movement: null, differences: 0 };
      const id = await this.insertMovement(t, {
        kind: StockMovementKind.Adjustment,
        to: location.id,
        note: dto.note,
        createdBy: user.id,
        lines: deltas,
      });
      await this.apply(t, location.id, deltas);
      return { movement: id, differences: deltas.length };
    });
  }

  // ------------------------------------------------------------ lecture

  async movement(user: AuthUser, id: string) {
    const [row] = await this.db.manager.query<
      {
        id: string;
        kind: StockMovementKind;
        status: StockMovementStatus;
        fromLocationId: string | null;
        fromName: string | null;
        toLocationId: string | null;
        toName: string | null;
        vanAgentId: string | null;
        orderId: string | null;
        note: string | null;
        createdBy: string | null;
        createdByName: string | null;
        confirmedByName: string | null;
        confirmedAt: Date | null;
        occurredAt: Date;
        lines: {
          productId: string;
          name: string;
          unit: string;
          packagings: unknown;
          quantity: number;
          received: number | null;
        }[];
      }[]
    >(
      `SELECT mv.id, mv.kind, mv.status,
              mv.from_location_id AS "fromLocationId", f.name AS "fromName",
              mv.to_location_id AS "toLocationId", tl.name AS "toName",
              coalesce(CASE WHEN f.kind = 'van' THEN f.agent_id END,
                       CASE WHEN tl.kind = 'van' THEN tl.agent_id END) AS "vanAgentId",
              mv.order_id AS "orderId", mv.note, mv.created_by AS "createdBy",
              nullif(trim(coalesce(cu.first_name, '') || ' ' || coalesce(cu.last_name, '')), '') AS "createdByName",
              nullif(trim(coalesce(vu.first_name, '') || ' ' || coalesce(vu.last_name, '')), '') AS "confirmedByName",
              mv.confirmed_at AS "confirmedAt", mv.occurred_at AS "occurredAt",
              coalesce((SELECT jsonb_agg(jsonb_build_object(
                         'productId', l.product_id,
                         'name', trim(p.name || ' ' || coalesce(p.format, '')),
                         'unit', p.unit, 'packagings', p.packagings,
                         'quantity', l.quantity::float8, 'received', l.received::float8)
                       ORDER BY p.name)
                        FROM stock_movement_lines l JOIN products p ON p.id = l.product_id
                        WHERE l.movement_id = mv.id), '[]') AS lines
       FROM stock_movements mv
       LEFT JOIN stock_locations f ON f.id = mv.from_location_id
       LEFT JOIN stock_locations tl ON tl.id = mv.to_location_id
       LEFT JOIN users cu ON cu.id = mv.created_by
       LEFT JOIN users vu ON vu.id = mv.confirmed_by
       WHERE mv.id = $1`,
      [id],
    );
    if (!row) throw notFound('Mouvement de stock');
    if (user.role === Role.Agent && row.vanAgentId !== user.id)
      throw notFound('Mouvement de stock');
    if (user.role === Role.TeamLead && row.vanAgentId) {
      const scope = await this.access.agentScope(user);
      if (scope && !scope.includes(row.vanAgentId))
        throw notFound('Mouvement de stock');
    }
    return { ...row, label: STOCK_MOVEMENT_KIND_LABELS[row.kind] };
  }

  /** Historique des mouvements, filtrable ; l'agent voit ceux de son camion. */
  async movements(user: AuthUser, q: MovementsQuery) {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (user.role === Role.Agent) {
      const van = await this.vanOf(user.id);
      if (!van) return { items: [], total: 0, page: q.page, limit: q.limit };
      where.push(
        `(mv.from_location_id = ${p(van.id)} OR mv.to_location_id = $${params.length})`,
      );
    } else if (user.role === Role.TeamLead) {
      const scope = await this.access.agentScope(user);
      if (scope)
        where.push(
          `NOT EXISTS (SELECT 1 FROM stock_locations x
                        WHERE x.id IN (mv.from_location_id, mv.to_location_id)
                          AND x.kind = 'van' AND x.agent_id IS NOT NULL
                          AND NOT x.agent_id = ANY(${p(scope)}::uuid[]))`,
        );
    }
    if (q.locationId)
      where.push(
        `(mv.from_location_id = ${p(q.locationId)} OR mv.to_location_id = $${params.length})`,
      );
    if (q.productId)
      where.push(
        `EXISTS (SELECT 1 FROM stock_movement_lines l WHERE l.movement_id = mv.id AND l.product_id = ${p(q.productId)})`,
      );
    if (q.kind) where.push(`mv.kind = ${p(q.kind)}`);
    if (q.status) where.push(`mv.status = ${p(q.status)}`);
    if (q.from || q.to) {
      const tz = (await this.access.settings()).timezone;
      const day = `(mv.occurred_at AT TIME ZONE ${p(tz)})::date`;
      if (q.from) where.push(`${day} >= ${p(q.from.slice(0, 10))}::date`);
      if (q.to) where.push(`${day} <= ${p(q.to.slice(0, 10))}::date`);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ total }] = await this.db.manager.query<{ total: number }[]>(
      `SELECT count(*)::int AS total FROM stock_movements mv ${filter}`,
      params,
    );
    const rows = await this.db.manager.query<{ id: string }[]>(
      `SELECT mv.id FROM stock_movements mv ${filter}
       ORDER BY mv.occurred_at DESC, mv.created_at DESC
       LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    const items = await Promise.all(rows.map((r) => this.movement(user, r.id)));
    return { items, total, page: q.page, limit: q.limit };
  }
}
