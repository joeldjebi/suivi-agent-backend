import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Espace super administrateur de l'éditeur : comptes de la plateforme (hors structures),
 * journal de leurs actions, conditions négociées par structure, suspension manuelle et
 * enregistrement des paiements de factures (Mobile Money, virement, espèces).
 */
export class Platform1760300000000 implements MigrationInterface {
  name = 'Platform1760300000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';

    // Comptes de l'éditeur : aucune structure, donc pas de Row Level Security.
    await q.query(`
      CREATE TABLE platform_admins (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL,
        password_hash text NOT NULL,
        first_name text NOT NULL,
        last_name text NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        last_login_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE UNIQUE INDEX platform_admins_email_idx ON platform_admins (lower(email))`,
    );
    await q.query(`
      CREATE TABLE platform_audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
        action text NOT NULL,
        tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
        details jsonb NOT NULL DEFAULT '{}',
        ip text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX platform_audit_created_idx ON platform_audit (created_at DESC)`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE ON platform_admins, platform_audit TO ${appUser}`,
    );
    // Catalogue et réglages : modifiables par l'éditeur depuis son espace.
    await q.query(`GRANT UPDATE ON plans, platform_settings TO ${appUser}`);

    await q.query(`
      ALTER TABLE tenants
        ADD COLUMN notes text,
        ADD COLUMN contact_phone text`);

    // Conditions négociées (null : celles de la formule) et suspension décidée par l'éditeur.
    await q.query(`
      ALTER TABLE subscriptions
        ADD COLUMN custom_monthly_price integer,
        ADD COLUMN custom_included_agents integer,
        ADD COLUMN custom_included_leads integer,
        ADD COLUMN manual_suspension boolean NOT NULL DEFAULT false,
        ADD COLUMN suspension_reason text`);

    await q.query(`
      ALTER TABLE invoices
        ADD COLUMN payment_method text,
        ADD COLUMN recorded_by text,
        ADD COLUMN void_reason text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE invoices
        DROP COLUMN payment_method, DROP COLUMN recorded_by, DROP COLUMN void_reason`);
    await q.query(`
      ALTER TABLE subscriptions
        DROP COLUMN custom_monthly_price, DROP COLUMN custom_included_agents,
        DROP COLUMN custom_included_leads, DROP COLUMN manual_suspension,
        DROP COLUMN suspension_reason`);
    await q.query(
      `ALTER TABLE tenants DROP COLUMN notes, DROP COLUMN contact_phone`,
    );
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(`REVOKE UPDATE ON plans, platform_settings FROM ${appUser}`);
    await q.query(`DROP TABLE platform_audit`);
    await q.query(`DROP TABLE platform_admins`);
  }
}
