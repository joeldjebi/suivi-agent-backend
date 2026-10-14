import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Catalogue de produits (les siens et ceux de la concurrence), avec unité de base et
 * conditionnements (« Casier = 12 bouteilles »), et relevés par produit enregistrés avec les
 * formulaires : une ligne par produit, quantités en unités de base. Fonctionnalité de la
 * formule Entreprise.
 */
export class Products1762700000000 implements MigrationInterface {
  name = 'Products1762700000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(`
      CREATE TABLE products (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name text NOT NULL,
        brand text,
        category text,
        -- « 33 cl », « 1 kg »…
        format text,
        -- Produit de la structure (sinon : concurrent)
        own boolean NOT NULL DEFAULT true,
        unit text NOT NULL DEFAULT 'Unité',
        packagings jsonb NOT NULL DEFAULT '[]',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX products_tenant_idx ON products (tenant_id, own, name)`,
    );
    await q.query(`
      CREATE TABLE product_readings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        submission_id uuid NOT NULL REFERENCES mission_submissions(id) ON DELETE CASCADE,
        mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        outlet_id uuid REFERENCES outlets(id) ON DELETE SET NULL,
        agent_id uuid REFERENCES users(id) ON DELETE SET NULL,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        field_key text NOT NULL,
        presence boolean,
        stock numeric,
        price numeric,
        sold numeric,
        losses numeric,
        ordered numeric,
        submitted_at timestamptz NOT NULL
      )`);
    await q.query(
      `CREATE INDEX product_readings_product_idx ON product_readings (product_id, submitted_at DESC)`,
    );
    await q.query(
      `CREATE INDEX product_readings_outlet_idx ON product_readings (outlet_id, submitted_at DESC)`,
    );
    await q.query(
      `CREATE INDEX product_readings_submission_idx ON product_readings (submission_id)`,
    );
    for (const table of ['products', 'product_readings']) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(
        `CREATE POLICY tenant_isolation ON ${table} USING (${policy}) WITH CHECK (${policy})`,
      );
      await q.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${appUser}`,
      );
    }
    await q.query(`
      UPDATE plans SET features = array_append(features, 'product_audits')
      WHERE code = 'enterprise' AND NOT ('product_audits' = ANY(features))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE plans SET features = array_remove(features, 'product_audits')`,
    );
    await q.query(`DROP TABLE product_readings`);
    await q.query(`DROP TABLE products`);
  }
}
