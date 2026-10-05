import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alertes intelligentes des responsables : signal perdu, agent immobile, batterie faible,
 * position simulée, hors zone prolongé, journée pas démarrée. Une alerte s'ouvre, se
 * referme d'elle-même quand la situation se règle, et peut être prise en charge.
 */
export class AgentAlerts1760900000000 implements MigrationInterface {
  name = 'AgentAlerts1760900000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;

    await q.query(`
      ALTER TABLE tenant_settings
        ADD COLUMN alert_start_time text,
        ADD COLUMN alert_late_minutes integer NOT NULL DEFAULT 30,
        ADD COLUMN alert_workdays integer[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
        ADD COLUMN alert_immobile_minutes integer DEFAULT 45,
        ADD COLUMN alert_immobile_radius_m integer NOT NULL DEFAULT 100,
        ADD COLUMN alert_battery_percent integer DEFAULT 15,
        ADD COLUMN alert_signal_lost boolean NOT NULL DEFAULT true,
        ADD COLUMN alert_mocked boolean NOT NULL DEFAULT true`);
    await q.query(`
      CREATE TABLE agent_alerts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_id uuid REFERENCES work_days(id) ON DELETE CASCADE,
        type text NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz,
        data jsonb NOT NULL DEFAULT '{}',
        acknowledged_at timestamptz,
        acknowledged_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
        note text
      )`);
    // Une seule alerte ouverte par agent et par type.
    await q.query(
      `CREATE UNIQUE INDEX agent_alerts_open_idx ON agent_alerts (agent_id, type) WHERE resolved_at IS NULL`,
    );
    await q.query(
      `CREATE INDEX agent_alerts_tenant_idx ON agent_alerts (tenant_id, started_at DESC)`,
    );
    await q.query(`ALTER TABLE agent_alerts ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE agent_alerts FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON agent_alerts USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON agent_alerts TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE agent_alerts`);
    await q.query(`
      ALTER TABLE tenant_settings
        DROP COLUMN alert_start_time,
        DROP COLUMN alert_late_minutes,
        DROP COLUMN alert_workdays,
        DROP COLUMN alert_immobile_minutes,
        DROP COLUMN alert_immobile_radius_m,
        DROP COLUMN alert_battery_percent,
        DROP COLUMN alert_signal_lost,
        DROP COLUMN alert_mocked`);
  }
}
