import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Présentations clients générées depuis la console éditeur : les informations d'un client
 * (nom, quartiers, effectifs, fonctions…) donnent le diaporama, les fiches et la liste de
 * démarrage. Un lien de partage secret ouvre la présentation sans compte.
 */
export class ClientPresentations1764000000000 implements MigrationInterface {
  name = 'ClientPresentations1764000000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    // Données de l'éditeur, hors structure : pas de Row Level Security.
    await q.query(`
      CREATE TABLE client_presentations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        content jsonb NOT NULL,
        tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
        share_token text,
        shared_at timestamptz,
        view_count integer NOT NULL DEFAULT 0,
        last_viewed_at timestamptz,
        created_by uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE UNIQUE INDEX client_presentations_token_idx ON client_presentations (share_token) WHERE share_token IS NOT NULL`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON client_presentations TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE client_presentations`);
  }
}
