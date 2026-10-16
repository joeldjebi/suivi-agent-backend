import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Produits concurrents signalés par les agents sur le terrain (nom, format, photo, point de
 * vente où ils l'ont vu) : l'administrateur les ajoute au catalogue d'un clic, les rattache à
 * un produit existant (doublon) ou les refuse avec un motif.
 */
export class ProductSuggestions1763100000000 implements MigrationInterface {
  name = 'ProductSuggestions1763100000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(`
      CREATE TABLE product_suggestions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        -- Identifiant généré sur le téléphone : un renvoi ne crée pas de doublon
        client_id uuid NOT NULL,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        outlet_id uuid REFERENCES outlets(id) ON DELETE SET NULL,
        name text NOT NULL,
        brand text,
        format text,
        category text,
        note text,
        photo_id uuid REFERENCES submission_photos(id) ON DELETE SET NULL,
        status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'rejected')),
        -- Produit du catalogue créé ou retrouvé à l'acceptation
        product_id uuid REFERENCES products(id) ON DELETE SET NULL,
        decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
        decided_at timestamptz,
        reject_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (agent_id, client_id)
      )`);
    await q.query(
      `CREATE INDEX product_suggestions_status_idx ON product_suggestions (tenant_id, status, created_at DESC)`,
    );
    await q.query(`ALTER TABLE product_suggestions ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE product_suggestions FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON product_suggestions USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON product_suggestions TO ${appUser}`,
    );
    // Une photo ne sert qu'une fois : formulaire, fiche de point de vente ou signalement.
    await q.query(
      `ALTER TABLE submission_photos ADD COLUMN suggestion_id uuid REFERENCES product_suggestions(id) ON DELETE SET NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE submission_photos DROP COLUMN suggestion_id`);
    await q.query(`DROP TABLE product_suggestions`);
  }
}
