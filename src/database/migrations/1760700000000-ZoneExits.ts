import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sorties de zone : chaque passage d'un agent hors de sa zone pendant sa journée, avec une
 * tolérance en mètres (imprécision du GPS en bordure) et un délai avant d'alerter son chef.
 */
export class ZoneExits1760700000000 implements MigrationInterface {
  name = 'ZoneExits1760700000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;

    await q.query(`
      ALTER TABLE tenant_settings
        ADD COLUMN zone_exit_tolerance_meters integer NOT NULL DEFAULT 30,
        ADD COLUMN zone_exit_alert_minutes integer NOT NULL DEFAULT 5`);
    await q.query(`
      CREATE TABLE zone_exits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        day_id uuid NOT NULL REFERENCES work_days(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        zone_id uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
        exited_at timestamptz NOT NULL,
        ended_at timestamptz,
        end_reason text,
        max_distance_m integer NOT NULL DEFAULT 0,
        alerted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX zone_exits_day_idx ON zone_exits (day_id)`);
    // Une seule sortie en cours par journée.
    await q.query(
      `CREATE UNIQUE INDEX zone_exits_open_idx ON zone_exits (day_id) WHERE ended_at IS NULL`,
    );
    await q.query(`ALTER TABLE zone_exits ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE zone_exits FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON zone_exits USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON zone_exits TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE zone_exits`);
    await q.query(`
      ALTER TABLE tenant_settings
        DROP COLUMN zone_exit_tolerance_meters,
        DROP COLUMN zone_exit_alert_minutes`);
  }
}
