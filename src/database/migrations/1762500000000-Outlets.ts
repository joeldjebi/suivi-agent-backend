import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Points de vente : répertoire de la structure (position, statut commercial, fiche
 * personnalisable), historique des statuts et photos de la fiche. Fonctionnalité de la
 * formule Entreprise (l'éditeur l'ajoute ou la retire ensuite depuis sa console).
 */
export class Outlets1762500000000 implements MigrationInterface {
  name = 'Outlets1762500000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(`
      CREATE TABLE outlets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name text NOT NULL,
        category text,
        manager_name text,
        phone text,
        landmark text,
        -- Sans position : point de vente importé « à localiser » par le premier agent sur place.
        location geometry(Point, 4326),
        accuracy double precision,
        status text NOT NULL DEFAULT 'new'
          CHECK (status IN ('new', 'prospect', 'active', 'inactive', 'closed')),
        status_changed_at timestamptz NOT NULL DEFAULT now(),
        photo_id uuid,
        data jsonb NOT NULL DEFAULT '{}',
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        -- Identifiant donné par le téléphone : une création hors ligne renvoyée deux fois n'en fait qu'une.
        client_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, client_id)
      )`);
    await q.query(
      `CREATE INDEX outlets_location_idx ON outlets USING gist (location)`,
    );
    await q.query(
      `CREATE INDEX outlets_tenant_idx ON outlets (tenant_id, status)`,
    );
    await q.query(`
      CREATE TABLE outlet_status_changes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
        from_status text,
        to_status text NOT NULL,
        comment text,
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX outlet_status_changes_outlet_idx ON outlet_status_changes (outlet_id, created_at DESC)`,
    );
    for (const table of ['outlets', 'outlet_status_changes']) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(
        `CREATE POLICY tenant_isolation ON ${table} USING (${policy}) WITH CHECK (${policy})`,
      );
      await q.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${appUser}`,
      );
    }
    // Photos de la fiche : visibles par toute l'équipe qui voit le point de vente.
    await q.query(
      `ALTER TABLE submission_photos ADD COLUMN outlet_id uuid REFERENCES outlets(id) ON DELETE CASCADE`,
    );
    // Champs de la fiche définis par la structure (mêmes types que les formulaires).
    await q.query(
      `ALTER TABLE tenant_settings ADD COLUMN outlet_fields jsonb NOT NULL DEFAULT '[]'`,
    );
    await q.query(`
      UPDATE plans SET features = array_append(features, 'points_of_sale')
      WHERE code = 'enterprise' AND NOT ('points_of_sale' = ANY(features))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE plans SET features = array_remove(features, 'points_of_sale')`,
    );
    await q.query(`ALTER TABLE tenant_settings DROP COLUMN outlet_fields`);
    await q.query(`ALTER TABLE submission_photos DROP COLUMN outlet_id`);
    await q.query(`DROP TABLE outlet_status_changes`);
    await q.query(`DROP TABLE outlets`);
  }
}
