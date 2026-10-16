import { Injectable } from '@nestjs/common';
import { Role } from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest, conflict, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { ProductsService } from './products.service';
import type {
  AcceptSuggestionDto,
  CreateSuggestionDto,
  ListSuggestionsQuery,
} from './suggestions.dto';

const SELECT = `
  s.id, s.name, s.brand, s.format, s.category, s.note, s.status,
  s.photo_id AS "photoId", s.created_at AS "createdAt", s.decided_at AS "decidedAt",
  s.reject_reason AS "rejectReason", s.product_id AS "productId",
  s.agent_id AS "agentId", trim(a.first_name || ' ' || a.last_name) AS "agentName",
  s.outlet_id AS "outletId", o.name AS "outletName",
  p.name AS "productName",
  nullif(trim(coalesce(d.first_name, '') || ' ' || coalesce(d.last_name, '')), '') AS "decidedBy"`;
const FROM = `
  FROM product_suggestions s
  JOIN users a ON a.id = s.agent_id
  LEFT JOIN outlets o ON o.id = s.outlet_id
  LEFT JOIN products p ON p.id = s.product_id
  LEFT JOIN users d ON d.id = s.decided_by`;

/**
 * Produits concurrents signalés par les agents sur le terrain. L'administrateur les ajoute au
 * catalogue (produit concurrent), les rattache à un produit existant, ou les refuse avec un
 * motif ; l'agent est prévenu de la décision.
 */
@Injectable()
export class SuggestionsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly products: ProductsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Signalement d'un agent (ou d'un chef) ; idempotent sur clientId. */
  async create(user: AuthUser, dto: CreateSuggestionDto) {
    const m = this.db.manager;
    const [existing] = await m.query<{ id: string }[]>(
      `SELECT id FROM product_suggestions WHERE agent_id = $1 AND client_id = $2`,
      [user.id, dto.clientId],
    );
    if (existing) return this.get(user, existing.id);
    if (dto.outletId) {
      const [outlet] = await m.query<{ id: string }[]>(
        `SELECT id FROM outlets WHERE id = $1`,
        [dto.outletId],
      );
      if (!outlet) throw notFound('Point de vente');
    }
    if (dto.photoId) {
      // Une photo de l'agent, encore libre (ni formulaire, ni fiche, ni autre signalement).
      const [photo] = await m.query<{ id: string }[]>(
        `SELECT id FROM submission_photos
         WHERE id = $1 AND agent_id = $2 AND submission_id IS NULL
           AND outlet_id IS NULL AND suggestion_id IS NULL`,
        [dto.photoId, user.id],
      );
      if (!photo)
        throw badRequest(
          'PHOTO_MISSING',
          'La photo est introuvable : reprenez-la',
        );
    }
    const [{ id }] = await m.query<{ id: string }[]>(
      `INSERT INTO product_suggestions (tenant_id, client_id, agent_id, outlet_id, name, brand,
                                        format, category, note, photo_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        this.db.tenantId,
        dto.clientId,
        user.id,
        dto.outletId ?? null,
        dto.name,
        dto.brand || null,
        dto.format || null,
        dto.category || null,
        dto.note || null,
        dto.photoId ?? null,
      ],
    );
    if (dto.photoId)
      await m.query(
        `UPDATE submission_photos SET suggestion_id = $1 WHERE id = $2`,
        [id, dto.photoId],
      );
    const suggestion = await this.get(user, id);
    await this.notifications.notify(await this.access.adminIds(), {
      type: 'product.suggested',
      title: 'Produit concurrent signalé',
      body: `${suggestion.agentName} : ${[dto.name, dto.format].filter(Boolean).join(' ')}${
        suggestion.outletName ? ` (${suggestion.outletName})` : ''
      }`,
      data: { suggestionId: id },
    });
    return suggestion;
  }

  /** Agent : les siens ; chef : ceux de son équipe ; administrateur : tous. */
  private async agents(user: AuthUser) {
    return user.role === Role.Admin ? null : this.access.agentScope(user);
  }

  async list(user: AuthUser, q: ListSuggestionsQuery) {
    return this.db.manager.query<Record<string, unknown>[]>(
      `SELECT ${SELECT} ${FROM}
       WHERE ($1::text IS NULL OR s.status = $1)
         AND ($2::uuid[] IS NULL OR s.agent_id = ANY($2::uuid[]))
       ORDER BY (s.status = 'pending') DESC, s.created_at DESC
       LIMIT 200`,
      [q.status ?? null, await this.agents(user)],
    );
  }

  async get(user: AuthUser, id: string) {
    const [row] = await this.db.manager.query<
      (Record<string, unknown> & {
        agentId: string;
        agentName: string;
        outletName: string | null;
        status: string;
        name: string;
      })[]
    >(
      `SELECT ${SELECT} ${FROM}
       WHERE s.id = $1 AND ($2::uuid[] IS NULL OR s.agent_id = ANY($2::uuid[]))`,
      [id, await this.agents(user)],
    );
    if (!row) throw notFound('Signalement');
    return row;
  }

  private async pending(user: AuthUser, id: string) {
    const s = await this.get(user, id);
    if (s.status !== 'pending')
      throw conflict('SUGGESTION_DECIDED', 'Ce signalement a déjà été traité');
    return s;
  }

  /** Ajout au catalogue comme produit concurrent, ou rattachement à un produit existant. */
  async accept(user: AuthUser, id: string, dto: AcceptSuggestionDto) {
    const s = await this.pending(user, id);
    let productId = dto.productId;
    if (productId) {
      await this.products.get(productId);
    } else {
      const product = await this.products.create({
        name: dto.name ?? s.name,
        brand: dto.brand ?? (s.brand as string | null),
        format: dto.format ?? (s.format as string | null),
        category: dto.category ?? (s.category as string | null),
        own: false,
        unit: dto.unit ?? 'Unité',
        packagings: dto.packagings ?? [],
      });
      productId = product.id;
    }
    await this.db.manager.query(
      `UPDATE product_suggestions SET status = 'accepted', product_id = $2, decided_by = $3,
              decided_at = now()
       WHERE id = $1`,
      [id, productId, user.id],
    );
    await this.notifications.notify([s.agentId], {
      type: 'product.suggestion_accepted',
      title: 'Produit concurrent ajouté',
      body: `${s.name} fait maintenant partie du catalogue. Merci !`,
      data: { suggestionId: id, productId },
    });
    return this.get(user, id);
  }

  async reject(user: AuthUser, id: string, reason: string) {
    const s = await this.pending(user, id);
    await this.db.manager.query(
      `UPDATE product_suggestions SET status = 'rejected', reject_reason = $2, decided_by = $3,
              decided_at = now()
       WHERE id = $1`,
      [id, reason, user.id],
    );
    await this.notifications.notify([s.agentId], {
      type: 'product.suggestion_rejected',
      title: 'Produit signalé non retenu',
      body: `${s.name} : ${reason}`,
      data: { suggestionId: id },
    });
    return this.get(user, id);
  }
}
