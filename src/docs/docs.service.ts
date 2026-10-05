import { Injectable } from '@nestjs/common';
import type { DocArticle, DocArticleSummary } from '@suivi/shared';
import { conflict, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { DocArticleEntity } from '../entities';
import type { PlatformUser } from '../platform/platform-auth';
import { DEFAULT_ARTICLES } from './docs.defaults';
import type { DocArticleDto, UpdateDocArticleDto } from './docs.dto';

const summary = (a: DocArticleEntity): DocArticleSummary => ({
  slug: a.slug,
  section: a.section,
  title: a.title,
  summary: a.summary,
  position: a.position,
  updatedAt: a.updatedAt.toISOString(),
});

/**
 * Manuel d'utilisation : commun à la plateforme, rédigé par l'éditeur, lu par les comptes
 * connectés selon leur rôle. Jamais public.
 */
@Injectable()
export class DocsService {
  constructor(private readonly db: DbService) {}

  /** Premier accès : le manuel par défaut est installé. */
  private async ensureDefaults() {
    const [{ n }] = await this.db.manager.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM doc_articles`,
    );
    if (n === 0) await this.insertDefaults();
  }

  private async insertDefaults() {
    for (const [i, a] of DEFAULT_ARTICLES.entries()) {
      await this.db.manager.query(
        `INSERT INTO doc_articles (slug, section, title, summary, body, audience, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (slug) DO NOTHING`,
        [
          a.slug,
          a.section,
          a.title,
          a.summary,
          a.body,
          a.audience,
          a.position ?? (i + 1) * 10,
        ],
      );
    }
  }

  /** Articles publiés pour ce rôle ; l'administrateur voit tout le manuel. */
  async list(role: string): Promise<DocArticleSummary[]> {
    await this.ensureDefaults();
    const rows = await this.db.manager.find(DocArticleEntity, {
      where: { published: true },
      order: { position: 'ASC' },
    });
    return rows.filter((a) => this.visible(a, role)).map(summary);
  }

  async get(role: string, slug: string): Promise<DocArticle> {
    await this.ensureDefaults();
    const a = await this.db.manager.findOneBy(DocArticleEntity, {
      slug,
      published: true,
    });
    if (!a || !this.visible(a, role)) throw notFound('Article');
    return { ...summary(a), body: a.body };
  }

  private visible(a: DocArticleEntity, role: string) {
    return role === 'admin' || a.audience.includes(role);
  }

  // ------------------------------------------------------------ éditeur

  async platformList() {
    await this.ensureDefaults();
    return this.db.manager.find(DocArticleEntity, {
      order: { position: 'ASC' },
    });
  }

  async create(admin: PlatformUser, dto: DocArticleDto) {
    if (await this.db.manager.existsBy(DocArticleEntity, { slug: dto.slug }))
      throw conflict('SLUG_TAKEN', 'Un article utilise déjà cette adresse');
    const [{ max }] = await this.db.manager.query<{ max: number | null }[]>(
      `SELECT max(position)::int AS max FROM doc_articles`,
    );
    return this.db.manager.save(DocArticleEntity, {
      ...dto,
      summary: dto.summary ?? '',
      position: dto.position ?? (max ?? 0) + 10,
      published: dto.published ?? true,
      updatedAt: new Date(),
      updatedBy: admin.email,
    });
  }

  async update(admin: PlatformUser, id: string, dto: UpdateDocArticleDto) {
    const m = this.db.manager;
    const article = await m.findOneBy(DocArticleEntity, { id });
    if (!article) throw notFound('Article');
    if (dto.slug && dto.slug !== article.slug)
      if (await m.existsBy(DocArticleEntity, { slug: dto.slug }))
        throw conflict('SLUG_TAKEN', 'Un article utilise déjà cette adresse');
    await m.update(
      DocArticleEntity,
      { id },
      { ...dto, updatedAt: new Date(), updatedBy: admin.email },
    );
    return m.findOneByOrFail(DocArticleEntity, { id });
  }

  async remove(id: string) {
    const result = await this.db.manager.delete(DocArticleEntity, { id });
    if (!result.affected) throw notFound('Article');
  }

  /** Réinstalle les articles par défaut manquants (les articles modifiés sont gardés). */
  async restoreDefaults() {
    await this.insertDefaults();
    return this.platformList();
  }
}
