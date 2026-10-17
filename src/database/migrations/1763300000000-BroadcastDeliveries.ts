import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Suivi des notifications aux équipes, destinataire par destinataire : envoyée au téléphone,
 * échec (avec sa raison), pas de téléphone enregistré, ou en cours ; nombre de tentatives
 * (renvois) et notification de l'app correspondante (pour savoir si elle a été lue).
 */
export class BroadcastDeliveries1763300000000 implements MigrationInterface {
  name = 'BroadcastDeliveries1763300000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(`
      CREATE TABLE broadcast_deliveries (
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        broadcast_id uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
        status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'sent', 'failed', 'no_device')),
        -- Code Firebase du dernier échec (ex. messaging/registration-token-not-registered)
        error_code text,
        attempts integer NOT NULL DEFAULT 0,
        last_attempt_at timestamptz,
        PRIMARY KEY (broadcast_id, user_id)
      )`);
    await q.query(
      `CREATE INDEX broadcast_deliveries_tenant_idx ON broadcast_deliveries (tenant_id, broadcast_id)`,
    );
    await q.query(`ALTER TABLE broadcast_deliveries ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE broadcast_deliveries FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON broadcast_deliveries USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_deliveries TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE broadcast_deliveries`);
  }
}
