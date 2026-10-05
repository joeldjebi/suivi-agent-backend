import { HttpStatus, Injectable } from '@nestjs/common';
import type { LandingContent, PublicLanding } from '@suivi/shared';
import {
  BusinessException,
  badRequest,
  notFound,
} from '../common/business.exception';
import { DbService } from '../common/db.service';
import { imageMime } from '../common/image';
import { normalizePhone } from '../common/phone';
import { RedisService } from '../common/redis.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { PlatformUser } from '../platform/platform-auth';
import { DEFAULT_LANDING } from './landing.defaults';
import type {
  DemoRequestDto,
  ListDemoRequestsQuery,
  UpdateDemoRequestDto,
} from './landing.dto';
import { sanitizeLanding } from './landing.sanitize';

/** Image du site : 2 Mo au plus (PNG, JPEG, WebP). */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
/** Le site public est mis en cache une minute (vidé à chaque publication). */
const CACHE_MS = 60_000;
/** Demandes de démo par adresse IP et par heure. */
const DEMO_PER_HOUR = 5;

interface LandingRow {
  draft: LandingContent | null;
  published: LandingContent | null;
  publishedAt: Date | null;
  publishedBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

/** Site vitrine : contenu (brouillon, publication), images et demandes de démo. */
@Injectable()
export class LandingService {
  private cache: { at: number; value: PublicLanding } | null = null;

  constructor(
    private readonly db: DbService,
    private readonly subscriptions: SubscriptionsService,
    private readonly redis: RedisService,
  ) {}

  private async row(): Promise<LandingRow> {
    const [row] = await this.db.manager.query<LandingRow[]>(
      `SELECT draft, published, published_at AS "publishedAt", published_by AS "publishedBy",
              updated_at AS "updatedAt", updated_by AS "updatedBy"
       FROM landing_pages WHERE id = 1`,
    );
    return row;
  }

  private log(admin: PlatformUser, action: string, details: object = {}) {
    return this.db.manager.query(
      `INSERT INTO platform_audit (admin_id, action, details) VALUES ($1, $2, $3)`,
      [admin.id, action, JSON.stringify(details)],
    );
  }

  // -------------------------------------------------------------- public

  /** Site publié (ou contenu d'origine), avec les formules proposées du catalogue. */
  async publicLanding(): Promise<PublicLanding> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS)
      return this.cache.value;
    const row = await this.row();
    const value = await this.withCatalog(row.published ?? DEFAULT_LANDING);
    this.cache = { at: Date.now(), value };
    return value;
  }

  private async withCatalog(content: LandingContent): Promise<PublicLanding> {
    const platform = await this.subscriptions.platform();
    const plans = await this.subscriptions.plans();
    return {
      content,
      plans: plans.map((p) => ({
        code: p.code,
        name: p.name,
        description: p.description,
        monthlyPrice: p.monthlyPrice,
        includedAgents: p.includedAgents,
        includedLeads: p.includedLeads,
        extraAgentPrice: p.extraAgentPrice,
        features: p.features,
      })),
      currency: platform.currency,
      trialDays: platform.trialDays,
      annualDiscountPercent: platform.annualDiscountPercent,
    };
  }

  async asset(id: string) {
    const [row] = await this.db.manager.query<{ mime: string; data: Buffer }[]>(
      `SELECT mime, data FROM landing_assets WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('Image');
    return row;
  }

  /** Demande de démo : champ piège contre les robots, 5 demandes par heure et par adresse. */
  async requestDemo(dto: DemoRequestDto, ip: string) {
    // Robot : on répond comme si tout allait bien, sans rien enregistrer.
    if (dto.website?.trim()) return { received: true };
    const key = `demo:ip:${ip}`;
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, 3600);
    if (count > DEMO_PER_HOUR)
      throw new BusinessException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_REQUESTS',
        'Vous avez déjà envoyé plusieurs demandes. Nous vous recontactons très vite.',
      );
    await this.db.manager.query(
      `INSERT INTO demo_requests (name, organization, email, phone, agents, message, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        dto.name.trim(),
        dto.organization.trim(),
        dto.email.trim().toLowerCase(),
        normalizePhone(dto.phone) ?? dto.phone.trim(),
        dto.agents ?? null,
        dto.message?.trim() || null,
        ip || null,
      ],
    );
    return { received: true };
  }

  // ------------------------------------------------------------- console

  /** Brouillon en cours (ou contenu publié, ou contenu d'origine) et état de publication. */
  async editor() {
    const row = await this.row();
    return {
      draft: row.draft ?? row.published ?? DEFAULT_LANDING,
      published: row.published,
      publishedAt: row.publishedAt,
      publishedBy: row.publishedBy,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      /** Brouillon différent de la version en ligne */
      hasChanges:
        !!row.draft &&
        JSON.stringify(row.draft) !==
          JSON.stringify(row.published ?? DEFAULT_LANDING),
    };
  }

  /** Aperçu du brouillon tel que le site l'affichera (formules du catalogue comprises). */
  async preview(): Promise<PublicLanding> {
    const { draft } = await this.editor();
    return this.withCatalog(draft);
  }

  async saveDraft(admin: PlatformUser, content: unknown) {
    const clean = sanitizeLanding(content);
    await this.assertAssets(clean);
    await this.db.manager.query(
      `UPDATE landing_pages SET draft = $1, updated_at = now(), updated_by = $2 WHERE id = 1`,
      [JSON.stringify(clean), admin.email],
    );
    return this.editor();
  }

  /** Les images citées doivent exister. */
  private async assertAssets(content: LandingContent) {
    const ids = [
      content.hero.imageId,
      ...content.sections.map((s) => (s.type === 'feature' ? s.imageId : null)),
    ].filter((id): id is string => !!id);
    if (!ids.length) return;
    const [{ found }] = await this.db.manager.query<{ found: number }[]>(
      `SELECT count(*)::int AS found FROM landing_assets WHERE id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    if (found !== new Set(ids).size)
      throw badRequest('INVALID_LANDING', 'Une image du contenu n’existe plus');
  }

  /** Mise en ligne du brouillon : le site public change dans la minute (cache vidé ici). */
  async publish(admin: PlatformUser) {
    const { draft } = await this.editor();
    await this.db.manager.query(
      `UPDATE landing_pages SET published = $1, draft = NULL, published_at = now(), published_by = $2
       WHERE id = 1`,
      [JSON.stringify(draft), admin.email],
    );
    this.db.afterCommit(() => (this.cache = null));
    await this.log(admin, 'landing.publish');
    return this.editor();
  }

  /** Abandon du brouillon : retour à la version en ligne. */
  async discard(admin: PlatformUser) {
    await this.db.manager.query(
      `UPDATE landing_pages SET draft = NULL, updated_at = now(), updated_by = $1 WHERE id = 1`,
      [admin.email],
    );
    return this.editor();
  }

  /** Retour au contenu d'origine (en brouillon : à publier ensuite). */
  async restoreDefaults(admin: PlatformUser) {
    await this.db.manager.query(
      `UPDATE landing_pages SET draft = $1, updated_at = now(), updated_by = $2 WHERE id = 1`,
      [JSON.stringify(DEFAULT_LANDING), admin.email],
    );
    return this.editor();
  }

  async uploadAsset(
    admin: PlatformUser,
    file: Express.Multer.File | undefined,
  ) {
    if (!file?.buffer?.length)
      throw badRequest(
        'IMAGE_REQUIRED',
        'Envoyez une image dans le champ « file »',
      );
    if (file.size > MAX_ASSET_BYTES)
      throw badRequest('IMAGE_TOO_LARGE', 'L’image ne doit pas dépasser 2 Mo');
    const mime = imageMime(file.buffer);
    if (!mime)
      throw badRequest('IMAGE_FORMAT', 'Formats acceptés : PNG, JPEG ou WebP');
    const [row] = await this.db.manager.query<{ id: string }[]>(
      `INSERT INTO landing_assets (mime, data, size, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [mime, file.buffer, file.size, admin.email],
    );
    return { id: row.id, url: `/api/public/landing/assets/${row.id}` };
  }

  async demoRequests(query: ListDemoRequestsQuery) {
    const { page, limit } = query;
    const rows = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT id, name, organization, email, phone, agents, message, status, notes,
              created_at AS "createdAt", updated_at AS "updatedAt", count(*) OVER()::int AS total
       FROM demo_requests
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [query.status ?? null, limit, (page - 1) * limit],
    );
    const [counts] = await this.db.manager.query<Record<string, number>[]>(
      `SELECT count(*) FILTER (WHERE status = 'new')::int AS new,
              count(*) FILTER (WHERE status = 'contacted')::int AS contacted,
              count(*) FILTER (WHERE status = 'won')::int AS won,
              count(*) FILTER (WHERE status = 'lost')::int AS lost
       FROM demo_requests`,
    );
    return {
      items: rows.map((r) => {
        const copy = { ...r };
        delete copy.total;
        return copy;
      }),
      total: (rows[0]?.total as number | undefined) ?? 0,
      page,
      limit,
      counts,
    };
  }

  async updateDemoRequest(
    admin: PlatformUser,
    id: string,
    dto: UpdateDemoRequestDto,
  ) {
    const [found] = await this.db.manager.query<unknown[]>(
      `SELECT 1 FROM demo_requests WHERE id = $1`,
      [id],
    );
    if (!found) throw notFound('Demande');
    await this.db.manager.query(
      `UPDATE demo_requests SET status = coalesce($2, status), notes = coalesce($3, notes), updated_at = now()
       WHERE id = $1`,
      [id, dto.status ?? null, dto.notes ?? null],
    );
    await this.log(admin, 'demo_request.update', {
      id,
      status: dto.status ?? null,
    });
    return { id };
  }
}
