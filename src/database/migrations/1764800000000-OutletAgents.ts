import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agent responsable d'un point de vente (son « commercial attitré ») et historique des
 * transferts d'un agent à l'autre. Les fiches existantes reviennent à leur créateur s'il est
 * agent ; les autres restent sans responsable (visibles des agents de la zone).
 */
export class OutletAgents1764800000000 implements MigrationInterface {
  name = 'OutletAgents1764800000000';

  public async up(q: QueryRunner): Promise<void> {
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(
      `ALTER TABLE outlets ADD COLUMN agent_id uuid REFERENCES users(id) ON DELETE SET NULL`,
    );
    await q.query(`CREATE INDEX outlets_agent_idx ON outlets (agent_id)`);
    await q.query(
      `UPDATE outlets o SET agent_id = o.created_by
       FROM users u WHERE u.id = o.created_by AND u.role = 'agent'`,
    );
    await q.query(`
      CREATE TABLE outlet_agent_changes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
        from_agent_id uuid REFERENCES users(id) ON DELETE SET NULL,
        to_agent_id uuid REFERENCES users(id) ON DELETE SET NULL,
        by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX outlet_agent_changes_outlet_idx ON outlet_agent_changes (outlet_id, created_at DESC)`,
    );
    await q.query(`ALTER TABLE outlet_agent_changes ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE outlet_agent_changes FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON outlet_agent_changes USING (${policy}) WITH CHECK (${policy})`,
    );
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON outlet_agent_changes TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE outlet_agent_changes`);
    await q.query(`ALTER TABLE outlets DROP COLUMN agent_id`);
  }
}
