import { MigrationInterface, QueryRunner } from 'typeorm';
import { DEFAULT_ARTICLES } from '../../docs/docs.defaults';

/** Empreinte du texte précédent de chaque article mis à jour. */
const PREVIOUS: Record<string, string> = {
  prerequis: '6948794bfb0d101a7cc699e5cb9a738c',
  'mettre-en-place': 'b11fd55f15ce97863b4f90891e8b74a3',
  alertes: '63027dc27fc2141c652d688d8796afba',
  'demandes-de-zone': 'd50270b7dc07c5794000f9fa0b80f0bd',
  journees: '4f4dab941ce79c327e9098071dff6e74',
  zones: 'b1ba1bd21be755cd1b0acc8e8b602dee',
  'equipes-et-comptes': '715a77b8272385407f5d5f69ad0e724b',
  missions: 'c42f4df7918f789790e111fea4decb19',
  abonnement: 'b8a73edfb5ad5e8256cb93220482ee20',
  support: '0cb0873eaa1a542193a83bfec11c6b41',
};

/**
 * Manuel : nouveaux noms du menu (En direct, Rapports, Équipe, Formulaires, Aide…) et
 * assistant de démarrage. Un article n'est remplacé que si l'éditeur ne l'a pas modifié.
 */
export class DocsNewMenu1762400000000 implements MigrationInterface {
  name = 'DocsNewMenu1762400000000';

  public async up(q: QueryRunner): Promise<void> {
    for (const [slug, md5] of Object.entries(PREVIOUS)) {
      const article = DEFAULT_ARTICLES.find((a) => a.slug === slug);
      if (!article) continue;
      await q.query(
        `UPDATE doc_articles SET body = $1, title = $2, updated_at = now()
         WHERE slug = $3 AND md5(body) = $4`,
        [article.body, article.title, slug, md5],
      );
    }
  }

  public async down(): Promise<void> {
    // Texte du manuel : pas de retour arrière.
  }
}
