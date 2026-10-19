import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Structure de démonstration d'une présentation client : créée en un clic avec le nom, la
 * couleur, les quartiers, les produits et les effectifs du client, et une activité réaliste.
 */
export class PresentationDemo1764100000000 implements MigrationInterface {
  name = 'PresentationDemo1764100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE client_presentations
        ADD COLUMN demo_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
        ADD COLUMN demo_admin_email text,
        ADD COLUMN demo_created_at timestamptz`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE client_presentations
        DROP COLUMN demo_tenant_id, DROP COLUMN demo_admin_email, DROP COLUMN demo_created_at`);
  }
}
