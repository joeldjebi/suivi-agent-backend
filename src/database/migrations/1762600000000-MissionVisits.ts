import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Missions de visites : liste précise de points de vente (mission_outlets) ou objectif
 * libre ; chaque formulaire est rattaché au point de vente visité, avec la distance mesurée.
 * La structure règle la distance maximale (50 m par défaut, 0 = pas de contrôle).
 */
export class MissionVisits1762600000000 implements MigrationInterface {
  name = 'MissionVisits1762600000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(
      `ALTER TABLE missions ADD COLUMN visit_mode text CHECK (visit_mode IN ('list', 'free'))`,
    );
    await q.query(`
      CREATE TABLE mission_outlets (
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
        PRIMARY KEY (mission_id, outlet_id)
      )`);
    await q.query(
      `CREATE INDEX mission_outlets_outlet_idx ON mission_outlets (outlet_id)`,
    );
    await q.query(`ALTER TABLE mission_outlets ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE mission_outlets FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON mission_outlets USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON mission_outlets TO ${appUser}`,
    );
    await q.query(`
      ALTER TABLE mission_submissions
        ADD COLUMN outlet_id uuid REFERENCES outlets(id) ON DELETE SET NULL,
        ADD COLUMN distance_m integer`);
    await q.query(
      `CREATE INDEX mission_submissions_outlet_idx ON mission_submissions (outlet_id) WHERE outlet_id IS NOT NULL`,
    );
    await q.query(
      `ALTER TABLE tenant_settings ADD COLUMN visit_radius_meters integer NOT NULL DEFAULT 50`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE tenant_settings DROP COLUMN visit_radius_meters`,
    );
    await q.query(
      `ALTER TABLE mission_submissions DROP COLUMN outlet_id, DROP COLUMN distance_m`,
    );
    await q.query(`DROP TABLE mission_outlets`);
    await q.query(`ALTER TABLE missions DROP COLUMN visit_mode`);
  }
}
