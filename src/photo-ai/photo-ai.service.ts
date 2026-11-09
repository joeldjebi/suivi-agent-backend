import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import {
  Feature,
  PHOTO_AI_SKIP_LABELS,
  Role,
  PhotoAnalysisStatus,
  type PhotoAiProviderChoice,
  type PhotoAiResult,
} from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest, conflict, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { PhotosService } from '../photos/photos.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { PhotoAiStatsQuery } from './photo-ai.dto';
import {
  type CatalogItem,
  PermanentAnalysisError,
  PHOTO_AI_PROVIDER,
  type PhotoAiProviders,
  type ReferenceImage,
} from './providers';

/** Délais avant chaque nouvel essai (1 min, 5 min, 30 min), puis échec définitif. */
const RETRY_DELAYS_S = [60, 300, 1800];
/** Analyses traitées en même temps. */
const BATCH = 3;
/** Photos de référence envoyées à l'IA avec chaque photo de rayon (coût : une image chacune). */
const MAX_REFERENCES = 8;

export interface PhotoAnalysis {
  photoId: string;
  status: PhotoAnalysisStatus;
  skipReason: string | null;
  skipLabel: string | null;
  result: PhotoAiResult | null;
  /** Nom, format et côté (nous ou concurrent) des produits du résultat */
  products: Record<
    string,
    { name: string; format: string | null; own: boolean }
  >;
  provider: string | null;
  model: string | null;
  error: string | null;
  attempts: number;
  createdAt: Date;
  analyzedAt: Date | null;
}

export interface PhotoAiUsage {
  /** Mois en cours, « 2026-11 » */
  month: string;
  /** Photos incluses par la formule chaque mois */
  quota: number;
  /** Photos accordées en plus ce mois-ci par l'éditeur */
  bonus: number;
  /** Photos analysées (ou en cours) ce mois-ci */
  used: number;
  remaining: number;
  /**
   * Au-delà du quota, les analyses continuent (facturées par lot de 100) : l'administrateur
   * l'a accepté, la formule a un prix de lot, et ni l'essai ni l'ancien tarif ne s'appliquent.
   */
  overage: boolean;
  /** L'administrateur accepte le dépassement (réglage) */
  overageAllowed: boolean;
  /** Prix d'un lot de 100 photos au-delà du quota (0 : pas de dépassement possible) */
  lotPrice: number;
  /** Photos au-delà du quota et du supplément ce mois-ci */
  overQuota: number;
  /** Analyse automatique des photos de rayon */
  auto: boolean;
  /** Une IA est branchée sur la plateforme */
  configured: boolean;
}

const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * IA photo : chaque photo de rayon est mise en file puis analysée en arrière-plan (modèle de
 * vision, voir providers.ts), dans la limite du quota mensuel de la formule et du supplément
 * accordé par l'éditeur. Une erreur passagère est réessayée ; le résultat pré-remplit les
 * relevés produits, que l'agent ou le chef confirme.
 */
@Injectable()
export class PhotoAiService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PhotoAiService.name);
  private timer: NodeJS.Timeout | null = null;
  private working = false;

  constructor(
    private readonly db: DbService,
    private readonly photos: PhotosService,
    private readonly subscriptions: SubscriptionsService,
    private readonly access: AccessService,
    @Optional()
    @Inject(PHOTO_AI_PROVIDER)
    private readonly providers: PhotoAiProviders | null,
  ) {}

  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test' || !this.providers?.any) return;
    this.timer = setInterval(() => void this.processQueue(), 10_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fournisseur choisi par l'éditeur dans la console (« off » : aucun). */
  async choice(): Promise<PhotoAiProviderChoice> {
    const [row] = await this.db.runAsSystem(() =>
      this.db.manager.query<{ provider: PhotoAiProviderChoice }[]>(
        `SELECT photo_ai_provider AS provider FROM platform_settings WHERE id = 1`,
      ),
    );
    return row?.provider ?? 'off';
  }

  /** Le fournisseur actif, s'il est choisi et branché (clé dans la configuration). */
  private async active() {
    const choice = await this.choice();
    const provider = this.providers?.get(choice) ?? null;
    return provider ? { id: choice, provider } : null;
  }

  // ------------------------------------------------------------ file d'attente

  /**
   * Photo de rayon envoyée : mise en file si la formule inclut l'IA photo et que l'analyse
   * automatique est active. Sinon, rien (la photo reste une photo).
   */
  async enqueueShelfPhoto(user: AuthUser, photoId: string) {
    const { features } = await this.subscriptions.summary(user.tenantId);
    if (!features.includes(Feature.PhotoAi)) return;
    const [settings] = await this.db.manager.query<{ auto: boolean }[]>(
      `SELECT photo_ai_auto AS auto FROM tenant_settings WHERE tenant_id = $1`,
      [user.tenantId],
    );
    if (settings && !settings.auto) return;
    await this.insert(photoId, user.id);
  }

  /**
   * Formulaire enregistré (visite, mission) : ses photos de rayon (champs photo « rayon »)
   * deviennent photos de rayon et sont mises en file. Une photo déjà analysée depuis l'app
   * (envoyée tôt pour pré-remplir le relevé) ne l'est pas deux fois.
   */
  async enqueueFormPhotos(
    user: AuthUser,
    fields: { key: string; type: string; shelf?: boolean }[],
    data: Record<string, unknown>,
  ) {
    const ids = fields
      .filter((f) => f.type === 'photo' && f.shelf)
      .map((f) => data[f.key])
      .filter((v): v is string => typeof v === 'string');
    if (!ids.length) return;
    await this.db.manager.query(
      `UPDATE submission_photos SET kind = 'shelf' WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const id of ids) await this.enqueueShelfPhoto(user, id);
  }

  /** Analyse demandée (ou redemandée) par un responsable pour une photo qu'il voit. */
  async request(user: AuthUser, photoId: string): Promise<PhotoAnalysis> {
    const photo = await this.photos.visible(user, photoId);
    // Une analyse consomme le quota : le chef ne la demande que pour les photos de ses agents.
    if (user.role === Role.TeamLead)
      await this.access.assertCanManageAgent(user, photo.agentId).catch(() => {
        throw notFound('Photo');
      });
    const [current] = await this.db.manager.query<{ status: string }[]>(
      `SELECT status FROM photo_analyses WHERE photo_id = $1`,
      [photoId],
    );
    if (current?.status === 'running')
      throw conflict(
        'ANALYSIS_RUNNING',
        'L’analyse de cette photo est en cours',
      );
    // Photo analysée à la demande : elle compte désormais comme photo de rayon.
    await this.db.manager.query(
      `UPDATE submission_photos SET kind = 'shelf' WHERE id = $1 AND kind IS NULL`,
      [photoId],
    );
    if (current)
      await this.db.manager.query(
        `UPDATE photo_analyses SET status = 'pending', skip_reason = NULL, error = NULL,
                attempts = 0, next_attempt_at = now(), requested_by = $2
         WHERE photo_id = $1`,
        [photoId, user.id],
      );
    else await this.insert(photoId, user.id);
    return this.get(user, photoId);
  }

  private async insert(photoId: string, userId: string) {
    await this.db.manager.query(
      `INSERT INTO photo_analyses (tenant_id, photo_id, requested_by)
       VALUES ($1, $2, $3) ON CONFLICT (photo_id) DO NOTHING`,
      [this.db.tenantId, photoId, userId],
    );
    // Sans attendre le prochain passage : l'agent est peut-être encore devant le rayon.
    if (this.providers?.any && process.env.NODE_ENV !== 'test')
      this.db.afterCommit(() => setImmediate(() => void this.processQueue()));
  }

  /**
   * Traite les analyses en attente (toutes structures), quelques-unes à la fois. Rend le
   * nombre d'analyses traitées. Appelée par la minuterie, et directement par les tests.
   */
  async processQueue(): Promise<number> {
    if (this.working) return 0;
    this.working = true;
    let processed = 0;
    try {
      for (;;) {
        const jobs = await this.db.runAsSystem(() =>
          this.db.manager.query<{ id: string; tenantId: string }[]>(
            // Une analyse restée « en cours » 10 minutes (serveur redémarré) est reprise.
            `WITH claimed AS (
               UPDATE photo_analyses SET status = 'running', attempts = attempts + 1,
                    next_attempt_at = now()
             WHERE id IN (
               SELECT id FROM photo_analyses
               WHERE (status = 'pending' AND next_attempt_at <= now())
                  OR (status = 'running' AND next_attempt_at < now() - interval '10 minutes')
               ORDER BY next_attempt_at LIMIT $1
               FOR UPDATE SKIP LOCKED
             )
             RETURNING id, tenant_id
             )
             SELECT id, tenant_id AS "tenantId" FROM claimed`,
            [BATCH],
          ),
        );
        if (!jobs.length) break;
        await Promise.all(
          jobs.map((j) =>
            this.db.runAsTenant(j.tenantId, () => this.run(j.id, j.tenantId)),
          ),
        );
        processed += jobs.length;
      }
    } catch (error) {
      this.logger.error('File de l’IA photo interrompue', error);
    } finally {
      this.working = false;
    }
    return processed;
  }

  /** Une analyse : quota, photo, catalogue, appel au modèle, résultat. */
  private async run(id: string, tenantId: string): Promise<void> {
    const m = this.db.manager;
    const skip = async (reason: string): Promise<void> => {
      await m.query(
        `UPDATE photo_analyses SET status = 'skipped', skip_reason = $2, analyzed_at = now()
         WHERE id = $1`,
        [id, reason],
      );
    };
    const active = await this.active();
    if (!active) return skip('not_configured');
    const { features } = await this.subscriptions.summary(tenantId);
    if (!features.includes(Feature.PhotoAi)) return skip('feature');
    const usage = await this.usageOf(tenantId, id);
    if (usage.remaining <= 0 && !usage.overage) return skip('quota');

    const [photo] = await m.query<
      {
        photoId: string;
        data: Buffer | null;
        storageKey: string | null;
        mime: string;
        attempts: number;
      }[]
    >(
      `SELECT p.id AS "photoId", p.data, p.storage_key AS "storageKey", p.mime, a.attempts
       FROM photo_analyses a JOIN submission_photos p ON p.id = a.photo_id
       WHERE a.id = $1`,
      [id],
    );
    const image = photo ? await this.photos.content(photo) : null;
    if (!photo || !image) {
      await m.query(
        `UPDATE photo_analyses SET status = 'failed', error = 'Photo introuvable', analyzed_at = now()
         WHERE id = $1`,
        [id],
      );
      return;
    }
    const catalog = await m.query<CatalogItem[]>(
      `SELECT id, name, brand, format, category, own FROM products
       WHERE is_active ORDER BY own DESC, category NULLS LAST, name LIMIT 200`,
    );
    const references = await this.references();
    try {
      const out = await active.provider.analyze({
        image,
        mime: photo.mime,
        catalog,
        references,
      });
      await m.query(
        `UPDATE photo_analyses SET status = 'done', result = $2, provider = $3, model = $4,
                input_tokens = $5, output_tokens = $6, cost_usd = $7, error = NULL,
                analyzed_at = now()
         WHERE id = $1`,
        [
          id,
          JSON.stringify(out.result),
          active.id,
          out.model,
          out.inputTokens,
          out.outputTokens,
          out.costUsd,
        ],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = RETRY_DELAYS_S[photo.attempts - 1];
      const final = error instanceof PermanentAnalysisError || delay == null;
      this.logger.warn(
        `Analyse ${id} : ${message}${final ? ' (abandon)' : ''}`,
      );
      await m.query(
        `UPDATE photo_analyses SET status = $2, error = $3,
                next_attempt_at = now() + make_interval(secs => $4),
                analyzed_at = CASE WHEN $2 = 'failed' THEN now() END
         WHERE id = $1`,
        [id, final ? 'failed' : 'pending', message.slice(0, 500), delay ?? 0],
      );
    }
  }

  /** Photos de référence des produits actifs (les nôtres d'abord), lisibles. */
  private async references(): Promise<ReferenceImage[]> {
    const rows = await this.db.manager.query<
      {
        productId: string;
        data: Buffer | null;
        storageKey: string | null;
        mime: string;
      }[]
    >(
      `SELECT pr.id AS "productId", p.data, p.storage_key AS "storageKey", p.mime
       FROM products pr JOIN submission_photos p ON p.id = pr.reference_photo_id
       WHERE pr.is_active ORDER BY pr.own DESC, pr.name LIMIT $1`,
      [MAX_REFERENCES],
    );
    const out: ReferenceImage[] = [];
    for (const r of rows) {
      const image = await this.photos.content(r);
      if (image) out.push({ productId: r.productId, image, mime: r.mime });
    }
    return out;
  }

  // ------------------------------------------------------------ photos de référence

  /** Photo de référence d'un produit (remplace la précédente). */
  async setReference(
    user: AuthUser,
    productId: string,
    file: Express.Multer.File | undefined,
  ) {
    const m = this.db.manager;
    const [product] = await m.query<{ old: string | null }[]>(
      `SELECT reference_photo_id AS old FROM products WHERE id = $1`,
      [productId],
    );
    if (!product) throw notFound('Produit');
    if (!file) throw badRequest('PHOTO_REQUIRED', 'Aucune photo reçue');
    const { id } = await this.photos.upload(user, file, {
      clientId: randomUUID(),
      takenAt: new Date().toISOString(),
    });
    await m.query(
      `UPDATE products SET reference_photo_id = $2, updated_at = now() WHERE id = $1`,
      [productId, id],
    );
    if (product.old) await this.photos.removeUnused(product.old);
    return { referencePhotoId: id };
  }

  async removeReference(productId: string) {
    const m = this.db.manager;
    const [product] = await m.query<{ old: string | null }[]>(
      `SELECT reference_photo_id AS old FROM products WHERE id = $1`,
      [productId],
    );
    if (!product) throw notFound('Produit');
    await m.query(
      `UPDATE products SET reference_photo_id = NULL, updated_at = now() WHERE id = $1`,
      [productId],
    );
    if (product.old) await this.photos.removeUnused(product.old);
  }

  // ------------------------------------------------------------ lecture

  async get(user: AuthUser, photoId: string): Promise<PhotoAnalysis> {
    await this.photos.visible(user, photoId);
    const [row] = await this.db.manager.query<PhotoAnalysis[]>(
      `SELECT photo_id AS "photoId", status, skip_reason AS "skipReason", result, provider,
              model, error,
              attempts, created_at AS "createdAt", analyzed_at AS "analyzedAt"
       FROM photo_analyses WHERE photo_id = $1`,
      [photoId],
    );
    if (!row) throw notFound('Analyse de la photo');
    const ids = row.result?.products.map((p) => p.productId) ?? [];
    const names = ids.length
      ? await this.db.manager.query<
          { id: string; name: string; format: string | null; own: boolean }[]
        >(
          `SELECT id, name, format, own FROM products WHERE id = ANY($1::uuid[])`,
          [ids],
        )
      : [];
    return {
      ...row,
      products: Object.fromEntries(
        names.map(({ id, ...p }) => [id, p] as const),
      ),
      skipLabel: row.skipReason
        ? (PHOTO_AI_SKIP_LABELS[row.skipReason] ?? row.skipReason)
        : null,
    };
  }

  /** Quota du mois : formule (celle de l'essai pendant l'essai), supplément, consommé. */
  usage(tenantId: string): Promise<PhotoAiUsage> {
    return this.usageOf(tenantId, null);
  }

  /** `except` : l'analyse en cours de traitement ne se compte pas elle-même. */
  private async usageOf(
    tenantId: string,
    except: string | null,
  ): Promise<PhotoAiUsage> {
    const month = monthOf();
    const [row] = await this.db.runAsSystem(() =>
      this.db.manager.query<
        {
          quota: number;
          bonus: number;
          used: number;
          auto: boolean;
          overageAllowed: boolean;
          lotPrice: number;
        }[]
      >(
        // Quota : formule d'essai pendant l'essai, ancien tarif tant qu'il est garanti.
        // Lot : seulement hors essai et hors ancien tarif (rien de facturé sinon).
        `WITH s AS (
           SELECT s.status, s.legacy_until > now() AS legacy, s.legacy_photo_ai_quota,
                  p.photo_ai_monthly_quota AS quota, own.photo_ai_extra_price AS lot
           FROM subscriptions s
           CROSS JOIN platform_settings ps
           JOIN plans p ON p.code = CASE WHEN s.status = 'trialing'
                                         THEN ps.trial_plan_code ELSE s.plan_code END
           JOIN plans own ON own.code = s.plan_code
           WHERE s.tenant_id = $1
         )
         SELECT coalesce((SELECT CASE WHEN status <> 'trialing' AND legacy IS TRUE
                                      THEN coalesce(legacy_photo_ai_quota, quota)
                                      ELSE quota END FROM s), 0)::int AS quota,
                coalesce((SELECT CASE WHEN status IN ('active', 'past_due') AND legacy IS NOT TRUE
                                      THEN lot ELSE 0 END FROM s), 0)::int AS "lotPrice",
                coalesce((SELECT photo_ai_overage FROM tenant_settings WHERE tenant_id = $1), false)
                  AS "overageAllowed",
                coalesce((SELECT photos FROM photo_ai_bonuses
                          WHERE tenant_id = $1 AND month = $2), 0)::int AS bonus,
                (SELECT count(*) FROM photo_analyses
                  WHERE tenant_id = $1 AND status IN ('done', 'running')
                    AND to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') = $2
                    AND id IS DISTINCT FROM $3)::int AS used,
                coalesce((SELECT photo_ai_auto FROM tenant_settings WHERE tenant_id = $1), true) AS auto`,
        [tenantId, month, except],
      ),
    );
    return {
      month,
      quota: row.quota,
      bonus: row.bonus,
      used: row.used,
      remaining: Math.max(0, row.quota + row.bonus - row.used),
      overage: row.overageAllowed && row.lotPrice > 0,
      overageAllowed: row.overageAllowed,
      lotPrice: row.lotPrice,
      overQuota: Math.max(0, row.used - row.quota - row.bonus),
      auto: row.auto,
      configured: !!(await this.active()),
    };
  }

  // ------------------------------------------------------------ statistiques des rayons

  /**
   * Rayons sur une période : score moyen, part de rayon de nos produits (faces), présence et
   * prix relevés par produit, évolution par semaine, dernier état de chaque point de vente.
   * Le chef ne voit que les photos de ses agents.
   */
  async stats(user: AuthUser, q: PhotoAiStatsQuery) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from
      ? new Date(q.from)
      : new Date(to.getTime() - 30 * 86_400_000);
    const scope = await this.access.agentScope(user);
    const m = this.db.manager;
    const base = `
      WITH a AS (
        SELECT a.id, a.photo_id, a.result, a.analyzed_at, p.agent_id, p.submission_id,
               coalesce(s.outlet_id, p.outlet_id) AS outlet_id
        FROM photo_analyses a
        JOIN submission_photos p ON p.id = a.photo_id
        LEFT JOIN mission_submissions s ON s.id = p.submission_id
        WHERE a.status = 'done' AND a.analyzed_at >= $1 AND a.analyzed_at < $2
          AND ($3::uuid[] IS NULL OR p.agent_id = ANY($3::uuid[]))
      ),
      items AS (
        SELECT a.id, (x->>'productId')::uuid AS product_id, (x->>'present')::boolean AS present,
               (x->>'facings')::numeric AS facings, (x->>'price')::numeric AS price
        FROM a CROSS JOIN jsonb_array_elements(a.result->'products') x
      ),
      per AS (
        SELECT a.*, (a.result->>'shelfScore')::int AS score,
               coalesce((SELECT sum(i.facings) FROM items i JOIN products pr ON pr.id = i.product_id
                          WHERE i.id = a.id AND i.present AND pr.own), 0) AS own_f,
               coalesce((SELECT sum(i.facings) FROM items i WHERE i.id = a.id AND i.present), 0)
                 + coalesce((SELECT sum((x->>'facings')::numeric)
                             FROM jsonb_array_elements(a.result->'others') x), 0) AS all_f
        FROM a
      )`;
    const params = [from, to, scope];
    const [summary] = await m.query<
      {
        analyses: number;
        outlets: number;
        avgScore: number | null;
        ownFacings: number;
        allFacings: number;
      }[]
    >(
      `${base}
       SELECT count(*)::int AS analyses, count(DISTINCT outlet_id)::int AS outlets,
              round(avg(score))::int AS "avgScore", coalesce(sum(own_f), 0)::float8 AS "ownFacings",
              coalesce(sum(all_f), 0)::float8 AS "allFacings"
       FROM per`,
      params,
    );
    const weeks = await m.query<
      {
        week: string;
        analyses: number;
        avgScore: number;
        share: number | null;
      }[]
    >(
      `${base}
       SELECT to_char(date_trunc('week', analyzed_at), 'YYYY-MM-DD') AS week,
              count(*)::int AS analyses, round(avg(score))::int AS "avgScore",
              CASE WHEN sum(all_f) > 0 THEN round(100 * sum(own_f) / sum(all_f))::int END AS share
       FROM per GROUP BY 1 ORDER BY 1`,
      params,
    );
    const products = await m.query<
      {
        productId: string;
        name: string;
        format: string | null;
        own: boolean;
        analyses: number;
        presence: number;
        avgFacings: number | null;
        avgPrice: number | null;
      }[]
    >(
      `${base}
       SELECT pr.id AS "productId", pr.name, pr.format, pr.own, count(*)::int AS analyses,
              round(100 * avg(i.present::int))::int AS presence,
              round(avg(i.facings) FILTER (WHERE i.present), 1)::float8 AS "avgFacings",
              round(avg(i.price) FILTER (WHERE i.present))::float8 AS "avgPrice"
       FROM items i JOIN products pr ON pr.id = i.product_id
       GROUP BY pr.id ORDER BY pr.own DESC, presence, pr.name`,
      params,
    );
    const outlets = await m.query<
      {
        outletId: string;
        outletName: string;
        analyzedAt: Date;
        score: number;
        share: number | null;
        missing: string[];
        photoId: string;
        submissionId: string | null;
        agent: string;
      }[]
    >(
      `${base}
       SELECT * FROM (
         SELECT DISTINCT ON (per.outlet_id) per.outlet_id AS "outletId", o.name AS "outletName",
                per.analyzed_at AS "analyzedAt", per.score,
                CASE WHEN per.all_f > 0 THEN round(100 * per.own_f / per.all_f)::int END AS share,
                coalesce((SELECT array_agg(pr.name || coalesce(' ' || pr.format, '') ORDER BY pr.name)
                          FROM items i JOIN products pr ON pr.id = i.product_id
                          WHERE i.id = per.id AND pr.own AND NOT i.present), '{}') AS missing,
                per.photo_id AS "photoId", per.submission_id AS "submissionId",
                trim(u.first_name || ' ' || u.last_name) AS agent
         FROM per JOIN outlets o ON o.id = per.outlet_id JOIN users u ON u.id = per.agent_id
         ORDER BY per.outlet_id, per.analyzed_at DESC
       ) last ORDER BY score, "analyzedAt" DESC LIMIT 100`,
      params,
    );
    return {
      from,
      to,
      analyses: summary.analyses,
      outletCount: summary.outlets,
      avgScore: summary.avgScore,
      share:
        summary.allFacings > 0
          ? Math.round((100 * summary.ownFacings) / summary.allFacings)
          : null,
      weeks,
      products,
      outlets,
    };
  }

  // ------------------------------------------------------------ console de l'éditeur

  /** Fournisseurs branchés, choix actif, analyses et coût du mois par fournisseur. */
  async overview() {
    const month = monthOf();
    const usage = await this.db.runAsSystem(() =>
      this.db.manager.query<
        { provider: string; analyses: number; costUsd: number }[]
      >(
        `SELECT coalesce(provider, '—') AS provider, count(*)::int AS analyses,
                coalesce(sum(cost_usd), 0)::float8 AS "costUsd"
         FROM photo_analyses
         WHERE status = 'done' AND to_char(analyzed_at AT TIME ZONE 'UTC', 'YYYY-MM') = $1
         GROUP BY 1 ORDER BY 2 DESC`,
        [month],
      ),
    );
    return {
      choice: await this.choice(),
      providers: this.providers?.list() ?? [],
      month,
      usage,
    };
  }

  /** Le fournisseur peut être choisi : clé présente dans la configuration du serveur. */
  isAvailable(choice: PhotoAiProviderChoice) {
    return choice === 'off' || !!this.providers?.get(choice);
  }

  /** Supplément du mois en cours accordé par l'éditeur (remplace le précédent). */
  async setBonus(tenantId: string, photos: number, note?: string) {
    const month = monthOf();
    await this.db.runAsSystem(() =>
      this.db.manager.query(
        `INSERT INTO photo_ai_bonuses (tenant_id, month, photos, note) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, month)
         DO UPDATE SET photos = excluded.photos, note = excluded.note, granted_at = now()`,
        [tenantId, month, photos, note || null],
      ),
    );
    return this.usage(tenantId);
  }
}
