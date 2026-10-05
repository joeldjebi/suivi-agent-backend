import { Injectable } from '@nestjs/common';
import type {
  AppOnboarding,
  AppOnboardingEditor,
  AppOnboardingEditorSlide,
  OnboardingAnimation,
} from '@suivi/shared';
import { badRequest, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import type { PlatformUser } from '../platform/platform-auth';
import { DEFAULT_SLIDES } from './app-onboarding.defaults';
import type {
  CreateSlideDto,
  ReorderSlidesDto,
  UpdateSlideDto,
} from './app-onboarding.dto';

export const MAX_SLIDES = 6;
export const MAX_LOTTIE_BYTES = 500 * 1024;

interface SlideRow {
  id: string;
  position: number;
  title: string;
  body: string;
  animation: OnboardingAnimation;
  color: string | null;
  hasLottie: boolean;
  lottieName: string | null;
  lottieSize: number | null;
  isActive: boolean;
  updatedAt: Date;
}

/** Animation Lottie importée : un objet JSON avec ses dimensions, sa durée et ses calques. */
function parseLottie(buffer: Buffer): object {
  let data: unknown;
  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw badRequest('LOTTIE_FORMAT', 'Le fichier n’est pas un JSON valide');
  }
  const l = data as Record<string, unknown>;
  const numbers = ['fr', 'ip', 'op', 'w', 'h'].every(
    (k) => typeof l?.[k] === 'number',
  );
  if (!numbers || !Array.isArray(l.layers))
    throw badRequest(
      'LOTTIE_FORMAT',
      'Ce fichier n’est pas une animation Lottie (exportez-la au format .json)',
    );
  return l;
}

/**
 * Onboarding de l'app mobile, commun à toutes les structures : lu sans connexion par l'app,
 * réglé par l'éditeur. L'app le montre au premier lancement, puis une fois de plus à chaque
 * nouvelle version publiée.
 */
@Injectable()
export class AppOnboardingService {
  constructor(private readonly db: DbService) {}

  private log(admin: PlatformUser, action: string, details: object = {}) {
    return this.db.manager.query(
      `INSERT INTO platform_audit (admin_id, action, details) VALUES ($1, $2, $3)`,
      [admin.id, action, JSON.stringify(details)],
    );
  }

  /** Premier accès : les pages d'origine sont installées (une seule fois). */
  private async settings() {
    const [row] = await this.db.manager.query<
      {
        enabled: boolean;
        version: number;
        initialized: boolean;
        publishedAt: Date | null;
      }[]
    >(
      `SELECT enabled, version, initialized, published_at AS "publishedAt" FROM app_onboarding WHERE id = 1`,
    );
    if (!row.initialized) {
      // Un seul appel installe les pages, même si plusieurs arrivent en même temps.
      const claimed = await this.db.manager.query<unknown[]>(
        `UPDATE app_onboarding SET initialized = true WHERE id = 1 AND NOT initialized RETURNING 1`,
      );
      if (claimed.length) await this.insertDefaults();
    }
    return row;
  }

  private async insertDefaults() {
    for (const [i, s] of DEFAULT_SLIDES.entries()) {
      await this.db.manager.query(
        `INSERT INTO app_onboarding_slides (position, title, body, animation) VALUES ($1, $2, $3, $4)`,
        [i + 1, s.title, s.body, s.animation],
      );
    }
  }

  private async rows(activeOnly = false): Promise<SlideRow[]> {
    return this.db.manager.query<SlideRow[]>(
      `SELECT id, position, title, body, animation, color, lottie IS NOT NULL AS "hasLottie",
              lottie_name AS "lottieName", lottie_size AS "lottieSize", is_active AS "isActive",
              updated_at AS "updatedAt"
       FROM app_onboarding_slides ${activeOnly ? 'WHERE is_active' : ''}
       ORDER BY position, created_at`,
    );
  }

  private slide(r: SlideRow) {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      animation: r.animation,
      color: r.color,
      // La version dans l'adresse change à chaque modification : l'app relit l'animation.
      lottieUrl: r.hasLottie
        ? `/api/public/app-onboarding/slides/${r.id}/lottie?v=${r.updatedAt.getTime()}`
        : null,
    };
  }

  // -------------------------------------------------------------- public

  async publicOnboarding(): Promise<AppOnboarding> {
    const settings = await this.settings();
    return {
      enabled: settings.enabled,
      version: settings.version,
      slides: (await this.rows(true)).map((r) => this.slide(r)),
    };
  }

  async lottie(id: string): Promise<object> {
    const [row] = await this.db.manager.query<{ lottie: object | null }[]>(
      `SELECT lottie FROM app_onboarding_slides WHERE id = $1 AND is_active`,
      [id],
    );
    if (!row?.lottie) throw notFound('Animation');
    return row.lottie;
  }

  // -------------------------------------------------------------- éditeur

  async editor(): Promise<AppOnboardingEditor> {
    const settings = await this.settings();
    return {
      enabled: settings.enabled,
      version: settings.version,
      publishedAt: settings.publishedAt?.toISOString() ?? null,
      slides: (await this.rows()).map((r): AppOnboardingEditorSlide => ({
        ...this.slide(r),
        position: r.position,
        isActive: r.isActive,
        lottieName: r.lottieName,
        lottieSize: r.lottieSize,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  async setEnabled(admin: PlatformUser, enabled: boolean) {
    await this.settings();
    await this.db.manager.query(
      `UPDATE app_onboarding SET enabled = $1, updated_at = now() WHERE id = 1`,
      [enabled],
    );
    await this.log(admin, 'app_onboarding.settings', { enabled });
    return this.editor();
  }

  async create(admin: PlatformUser, dto: CreateSlideDto) {
    await this.settings();
    const [{ n, next }] = await this.db.manager.query<
      { n: number; next: number }[]
    >(
      `SELECT count(*)::int AS n, coalesce(max(position), 0) + 1 AS next FROM app_onboarding_slides`,
    );
    if (n >= MAX_SLIDES)
      throw badRequest(
        'TOO_MANY_SLIDES',
        `L’onboarding compte au plus ${MAX_SLIDES} pages`,
      );
    const [row] = await this.db.manager.query<{ id: string }[]>(
      `INSERT INTO app_onboarding_slides (position, title, body, animation, color, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        next,
        dto.title.trim(),
        dto.body.trim(),
        dto.animation,
        dto.color ?? null,
        dto.isActive ?? true,
      ],
    );
    await this.log(admin, 'app_onboarding.slide_created', {
      id: row.id,
      title: dto.title,
    });
    return this.editor();
  }

  private async assertExists(id: string) {
    const [row] = await this.db.manager.query<unknown[]>(
      `SELECT 1 FROM app_onboarding_slides WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('Page');
  }

  async update(admin: PlatformUser, id: string, dto: UpdateSlideDto) {
    await this.assertExists(id);
    if (dto.isActive === false) await this.assertKeepsOne(id);
    const columns: Record<string, unknown> = {
      title: dto.title?.trim(),
      body: dto.body?.trim(),
      animation: dto.animation,
      color: dto.color,
      is_active: dto.isActive,
    };
    const set = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (set.length) {
      await this.db.manager.query(
        `UPDATE app_onboarding_slides SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')},
                updated_at = now()
         WHERE id = $1`,
        [id, ...set.map(([, v]) => v)],
      );
    }
    await this.log(admin, 'app_onboarding.slide_updated', { id, ...dto });
    return this.editor();
  }

  /** L'onboarding garde au moins une page affichée. */
  private async assertKeepsOne(id: string) {
    const [{ n }] = await this.db.manager.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM app_onboarding_slides WHERE is_active AND id <> $1`,
      [id],
    );
    if (n === 0)
      throw badRequest(
        'LAST_SLIDE',
        'Gardez au moins une page affichée (ou désactivez l’onboarding)',
      );
  }

  async remove(admin: PlatformUser, id: string) {
    await this.assertExists(id);
    await this.assertKeepsOne(id);
    await this.db.manager.query(
      `DELETE FROM app_onboarding_slides WHERE id = $1`,
      [id],
    );
    await this.log(admin, 'app_onboarding.slide_deleted', { id });
    return this.editor();
  }

  async reorder(admin: PlatformUser, dto: ReorderSlidesDto) {
    const current = (await this.rows()).map((r) => r.id);
    const ids = [...new Set(dto.ids)];
    if (
      ids.length !== current.length ||
      !current.every((id) => ids.includes(id))
    )
      throw badRequest('INVALID_ORDER', 'Indiquez toutes les pages, une fois');
    for (const [i, id] of ids.entries()) {
      await this.db.manager.query(
        `UPDATE app_onboarding_slides SET position = $2 WHERE id = $1`,
        [id, i + 1],
      );
    }
    await this.log(admin, 'app_onboarding.reordered', { ids });
    return this.editor();
  }

  async setLottie(
    admin: PlatformUser,
    id: string,
    file: Express.Multer.File | undefined,
  ) {
    await this.assertExists(id);
    if (!file?.buffer?.length)
      throw badRequest(
        'LOTTIE_REQUIRED',
        'Envoyez l’animation dans le champ « file »',
      );
    if (file.size > MAX_LOTTIE_BYTES)
      throw badRequest(
        'LOTTIE_TOO_LARGE',
        'L’animation ne doit pas dépasser 500 Ko',
      );
    const lottie = parseLottie(file.buffer);
    const name = (file.originalname || 'animation.json').slice(0, 100);
    await this.db.manager.query(
      `UPDATE app_onboarding_slides SET lottie = $2, lottie_name = $3, lottie_size = $4, updated_at = now()
       WHERE id = $1`,
      [id, JSON.stringify(lottie), name, file.size],
    );
    await this.log(admin, 'app_onboarding.lottie_uploaded', { id, name });
    return this.editor();
  }

  async clearLottie(admin: PlatformUser, id: string) {
    await this.assertExists(id);
    await this.db.manager.query(
      `UPDATE app_onboarding_slides SET lottie = NULL, lottie_name = NULL, lottie_size = NULL,
              updated_at = now()
       WHERE id = $1`,
      [id],
    );
    await this.log(admin, 'app_onboarding.lottie_removed', { id });
    return this.editor();
  }

  /** Nouvelle version : l'app remontre l'onboarding une fois à tous ses utilisateurs. */
  async republish(admin: PlatformUser) {
    await this.settings();
    const [{ version }] = await this.db.manager.query<{ version: number }[]>(
      `UPDATE app_onboarding SET version = version + 1, published_at = now(), updated_at = now()
       WHERE id = 1 RETURNING version`,
    );
    await this.log(admin, 'app_onboarding.republished', { version });
    return this.editor();
  }

  /** Remplace toutes les pages par celles d'origine. */
  async restoreDefaults(admin: PlatformUser) {
    await this.settings();
    await this.db.manager.query(`DELETE FROM app_onboarding_slides`);
    await this.insertDefaults();
    await this.log(admin, 'app_onboarding.restored_defaults');
    return this.editor();
  }
}
