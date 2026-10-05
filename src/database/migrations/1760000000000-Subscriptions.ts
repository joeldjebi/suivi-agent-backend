import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Abonnement des structures : prix par agent actif et par mois, trois formules, essai gratuit
 * de 14 jours, remise sur l'engagement annuel. Montants provisoires, modifiables par l'éditeur.
 */
export class Subscriptions1760000000000 implements MigrationInterface {
  name = 'Subscriptions1760000000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;

    // Catalogue et réglages de la plateforme : communs à toutes les structures.
    await q.query(`
      CREATE TABLE plans (
        code text PRIMARY KEY,
        name text NOT NULL,
        description text NOT NULL,
        price_per_agent integer NOT NULL,
        sort integer NOT NULL,
        is_active boolean NOT NULL DEFAULT true
      )`);
    await q.query(`
      INSERT INTO plans (code, name, description, price_per_agent, sort) VALUES
        ('base', 'Base', 'Suivi en temps réel, zones, journées et historique.', 1500, 1),
        ('advanced', 'Avancée', 'Groupes et chefs d''équipe, validation des zones, missions et formulaires, app personnalisée.', 2500, 2),
        ('enterprise', 'Entreprise', 'Tout Avancée, plus statistiques, suivi des chefs d''équipe et journal d''accès.', 4000, 3)`);
    await q.query(`
      CREATE TABLE platform_settings (
        id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        currency text NOT NULL DEFAULT 'XOF',
        trial_days integer NOT NULL DEFAULT 14,
        annual_discount_percent integer NOT NULL DEFAULT 15,
        invoice_due_days integer NOT NULL DEFAULT 15,
        suspend_after_days integer NOT NULL DEFAULT 15
      )`);
    await q.query(`INSERT INTO platform_settings DEFAULT VALUES`);
    await q.query(`GRANT SELECT ON plans, platform_settings TO ${appUser}`);

    await q.query(`
      CREATE TABLE subscriptions (
        tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        plan_code text NOT NULL REFERENCES plans(code),
        billing_cycle text NOT NULL DEFAULT 'monthly',
        status text NOT NULL,
        trial_ends_at timestamptz,
        /** Fin de l'engagement annuel */
        commitment_ends_at timestamptz,
        suspended_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        number text NOT NULL UNIQUE,
        month date NOT NULL,
        plan_code text NOT NULL,
        billing_cycle text NOT NULL,
        active_agents integer NOT NULL,
        unit_price integer NOT NULL,
        discount_percent integer NOT NULL DEFAULT 0,
        amount integer NOT NULL,
        currency text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        issued_at timestamptz NOT NULL DEFAULT now(),
        due_at timestamptz NOT NULL,
        paid_at timestamptz,
        payment_reference text,
        UNIQUE (tenant_id, month)
      )`);
    await q.query(
      `CREATE INDEX invoices_status_idx ON invoices (status, due_at)`,
    );
    for (const table of ['subscriptions', 'invoices']) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(
        `CREATE POLICY tenant_isolation ON ${table} USING (${policy}) WITH CHECK (${policy})`,
      );
      await q.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${appUser}`,
      );
    }
    // Structures existantes : clientes actives, formule Entreprise (rien ne se ferme).
    await q.query(`
      INSERT INTO subscriptions (tenant_id, plan_code, status)
      SELECT id, 'enterprise', 'active' FROM tenants`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE invoices`);
    await q.query(`DROP TABLE subscriptions`);
    await q.query(`DROP TABLE platform_settings`);
    await q.query(`DROP TABLE plans`);
  }
}
