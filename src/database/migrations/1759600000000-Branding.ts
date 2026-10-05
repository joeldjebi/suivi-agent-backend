import { MigrationInterface, QueryRunner } from 'typeorm';

/** Personnalisation de l'app mobile par la structure (appliquée une fois l'agent connecté). */
export class Branding1759600000000 implements MigrationInterface {
  name = 'Branding1759600000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(`
      CREATE TABLE tenant_branding (
        tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        display_name text,
        primary_color text NOT NULL DEFAULT '#2563EB',
        welcome_message text,
        support_phone text,
        logo bytea,
        logo_mime text,
        version integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `INSERT INTO tenant_branding (tenant_id) SELECT id FROM tenants`,
    );
    await q.query(`ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE tenant_branding FORCE ROW LEVEL SECURITY`);
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(
      `CREATE POLICY tenant_isolation ON tenant_branding USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_branding TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE tenant_branding`);
  }
}
