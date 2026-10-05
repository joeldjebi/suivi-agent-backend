import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Support : demandes d'aide des structures, traitées par l'éditeur (fil de messages).
 * Documentation : manuel d'utilisation, rédigé par l'éditeur, lu par les comptes connectés.
 */
export class SupportDocs1761000000000 implements MigrationInterface {
  name = 'SupportDocs1761000000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;

    await q.query(`CREATE SEQUENCE support_ticket_number_seq START 1001`);
    await q.query(`
      CREATE TABLE support_tickets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        number integer NOT NULL UNIQUE DEFAULT nextval('support_ticket_number_seq'),
        created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
        subject text NOT NULL,
        category text NOT NULL,
        status text NOT NULL DEFAULT 'open',
        context jsonb NOT NULL DEFAULT '{}',
        last_author text NOT NULL DEFAULT 'tenant',
        last_message_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        closed_at timestamptz
      )`);
    await q.query(`
      CREATE TABLE support_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        author_kind text NOT NULL,
        author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        platform_admin_id uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
        author_name text NOT NULL,
        body text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX support_tickets_status_idx ON support_tickets (status, last_message_at DESC)`,
    );
    await q.query(
      `CREATE INDEX support_messages_ticket_idx ON support_messages (ticket_id, created_at)`,
    );
    for (const table of ['support_tickets', 'support_messages']) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(
        `CREATE POLICY tenant_isolation ON ${table} USING (${policy}) WITH CHECK (${policy})`,
      );
      await q.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${appUser}`,
      );
    }
    await q.query(
      `GRANT USAGE, SELECT ON SEQUENCE support_ticket_number_seq TO ${appUser}`,
    );

    // Documentation : commune à toute la plateforme (pas de structure).
    await q.query(`
      CREATE TABLE doc_articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL UNIQUE,
        section text NOT NULL,
        title text NOT NULL,
        summary text NOT NULL DEFAULT '',
        body text NOT NULL,
        audience text[] NOT NULL DEFAULT '{admin,team_lead}',
        position integer NOT NULL DEFAULT 0,
        published boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      )`);
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON doc_articles TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE doc_articles`);
    await q.query(`DROP TABLE support_messages`);
    await q.query(`DROP TABLE support_tickets`);
    await q.query(`DROP SEQUENCE support_ticket_number_seq`);
  }
}
