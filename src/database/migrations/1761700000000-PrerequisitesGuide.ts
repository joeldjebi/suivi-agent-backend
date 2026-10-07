import { MigrationInterface, QueryRunner } from 'typeorm';
import { DEFAULT_ARTICLES } from '../../docs/docs.defaults';

/**
 * Manuel : l'article « Avant de commencer » devient un guide pas à pas. L'article déjà installé
 * est remplacé seulement s'il n'a pas été modifié par l'éditeur (même texte que l'ancienne
 * version) ; sinon, le texte de l'éditeur est conservé.
 */
export class PrerequisitesGuide1761700000000 implements MigrationInterface {
  name = 'PrerequisitesGuide1761700000000';

  public async up(q: QueryRunner): Promise<void> {
    const article = DEFAULT_ARTICLES.find((a) => a.slug === 'prerequis');
    if (!article) return;
    await q.query(
      `UPDATE doc_articles SET title = $1, summary = $2, body = $3, updated_at = now()
       WHERE slug = 'prerequis' AND md5(body) = '285bac3044afc30caa2dd426a500bacb'`,
      [article.title, article.summary, article.body],
    );
  }

  public async down(): Promise<void> {
    // Texte du manuel : pas de retour arrière.
  }
}
