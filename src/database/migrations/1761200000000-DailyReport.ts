import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bilan de fin de journée envoyé aux responsables (heure réglable) et messages du chef à son
 * équipe (traçés : qui a écrit quoi, à qui).
 */
export class DailyReport1761200000000 implements MigrationInterface {
  name = 'DailyReport1761200000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(`
      ALTER TABLE tenant_settings
        ADD COLUMN daily_report_time text DEFAULT '19:00',
        ADD COLUMN last_report_date date`);
    await q.query(`
      CREATE TABLE team_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        author_id uuid REFERENCES users(id) ON DELETE SET NULL,
        body text NOT NULL,
        recipient_ids uuid[] NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX team_messages_author_idx ON team_messages (author_id, created_at DESC)`,
    );
    await q.query(`ALTER TABLE team_messages ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE team_messages FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON team_messages USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON team_messages TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE team_messages`);
    await q.query(`
      ALTER TABLE tenant_settings DROP COLUMN daily_report_time, DROP COLUMN last_report_date`);
  }
}
