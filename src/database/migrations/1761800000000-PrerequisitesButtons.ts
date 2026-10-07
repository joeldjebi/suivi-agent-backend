import { MigrationInterface, QueryRunner } from 'typeorm';
import { DEFAULT_ARTICLES } from '../../docs/docs.defaults';

/**
 * Manuel : le guide « Avant de commencer » reçoit des boutons qui ouvrent chaque écran (avec
 * son formulaire de création). Remplace la version précédente du guide seulement si
 * l'éditeur ne l'a pas modifiée.
 */
export class PrerequisitesButtons1761800000000 implements MigrationInterface {
  name = 'PrerequisitesButtons1761800000000';

  public async up(q: QueryRunner): Promise<void> {
    const article = DEFAULT_ARTICLES.find((a) => a.slug === 'prerequis');
    if (!article) return;
    await q.query(
      `UPDATE doc_articles SET body = $1, updated_at = now()
       WHERE slug = 'prerequis' AND md5(body) = 'd975ccc978cb983a73fcf8cb5e8d9a44'`,
      [article.body],
    );
  }

  public async down(): Promise<void> {
    // Texte du manuel : pas de retour arrière.
  }
}
