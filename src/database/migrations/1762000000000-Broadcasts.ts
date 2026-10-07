import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications envoyées par l'administrateur aux agents et chefs d'équipe (tous, par rôle,
 * personnes choisies, par zone ou par mission) : traçées avec leur audience et leurs
 * destinataires.
 */
export class Broadcasts1762000000000 implements MigrationInterface {
  name = 'Broadcasts1762000000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(`
      CREATE TABLE broadcasts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        author_id uuid REFERENCES users(id) ON DELETE SET NULL,
        title text NOT NULL,
        body text NOT NULL,
        audience jsonb NOT NULL,
        recipient_ids uuid[] NOT NULL,
        reachable integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX broadcasts_tenant_idx ON broadcasts (tenant_id, created_at DESC)`,
    );
    await q.query(`ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE broadcasts FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON broadcasts USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON broadcasts TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE broadcasts`);
  }
}
