import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nouvelle grille tarifaire (validée le 9 novembre 2026) :
 * - Essentiel (ex-Base) 15 000 / 10 agents / +1 000 ; Pro (ex-Avancée) 45 000 / 25 / +1 500 ;
 *   Entreprise 120 000 / 50 / +2 000, avec la vente en camion à 3 000 par camion actif du mois
 *   et l'IA photo à 200 photos comprises puis 2 500 le lot de 100.
 * - Clients actuels protégés 6 mois : leurs conditions sont figées (legacy_*) et un rappel
 *   part un mois avant la fin.
 * - Mise en place (forfaits réglés par l'éditeur) : frais ponctuels ajoutés à la prochaine
 *   facture (one_time_charges).
 * - Factures détaillées ligne par ligne (lines).
 * - IA photo au-delà du quota : seulement si l'administrateur l'accepte (photo_ai_overage).
 */
export class PricingGrid1764900000000 implements MigrationInterface {
  name = 'PricingGrid1764900000000';

  public async up(q: QueryRunner): Promise<void> {
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';

    await q.query(
      `ALTER TABLE plans ADD COLUMN van_price integer NOT NULL DEFAULT 0 CHECK (van_price >= 0)`,
    );
    await q.query(`
      ALTER TABLE subscriptions
        ADD COLUMN legacy_until timestamptz,
        ADD COLUMN legacy_monthly_price integer,
        ADD COLUMN legacy_included_agents integer,
        ADD COLUMN legacy_included_leads integer,
        ADD COLUMN legacy_extra_agent_price integer,
        ADD COLUMN legacy_photo_ai_quota integer,
        ADD COLUMN legacy_notified_at timestamptz`);
    await q.query(
      `ALTER TABLE tenant_settings ADD COLUMN photo_ai_overage boolean NOT NULL DEFAULT false`,
    );
    await q.query(`
      ALTER TABLE platform_settings ADD COLUMN onboarding_packages jsonb NOT NULL DEFAULT '[]'`);
    await q.query(`
      UPDATE platform_settings SET onboarding_packages = '[
        {"code": "start", "name": "Démarrage", "price": 50000,
         "description": "Formation à distance, import de vos points de vente et de vos produits."},
        {"code": "assisted", "name": "Accompagné", "price": 250000,
         "description": "Formation sur place, configuration complète, un mois de suivi."}
      ]'::jsonb`);
    await q.query(`
      ALTER TABLE invoices
        ADD COLUMN van_count integer NOT NULL DEFAULT 0,
        ADD COLUMN van_price integer NOT NULL DEFAULT 0,
        ADD COLUMN photo_ai_lots integer NOT NULL DEFAULT 0,
        ADD COLUMN photo_ai_lot_price integer NOT NULL DEFAULT 0,
        ADD COLUMN one_time_amount integer NOT NULL DEFAULT 0,
        ADD COLUMN lines jsonb NOT NULL DEFAULT '[]'`);

    await q.query(`
      CREATE TABLE one_time_charges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        label text NOT NULL,
        amount integer NOT NULL CHECK (amount > 0),
        package_code text,
        note text,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL
      )`);
    await q.query(
      `CREATE INDEX one_time_charges_tenant_idx ON one_time_charges (tenant_id, created_at)`,
    );
    await q.query(`ALTER TABLE one_time_charges ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE one_time_charges FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON one_time_charges USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON one_time_charges TO ${appUser}`,
    );

    // Clients actuels : leurs conditions de maintenant, pendant 6 mois.
    await q.query(`
      UPDATE subscriptions s SET
        legacy_until = now() + interval '6 months',
        legacy_monthly_price = p.monthly_price,
        legacy_included_agents = p.included_agents,
        legacy_included_leads = p.included_leads,
        legacy_extra_agent_price = p.extra_agent_price,
        legacy_photo_ai_quota = p.photo_ai_monthly_quota
      FROM plans p
      WHERE p.code = s.plan_code AND s.status <> 'cancelled'`);

    // La nouvelle grille.
    await q.query(`
      UPDATE plans SET name = 'Essentiel', monthly_price = 15000, included_agents = 10,
                       extra_agent_price = 1000
      WHERE code = 'base'`);
    await q.query(`
      UPDATE plans SET name = 'Pro', monthly_price = 45000, included_agents = 25,
                       extra_agent_price = 1500
      WHERE code = 'advanced'`);
    await q.query(`
      UPDATE plans SET monthly_price = 120000, included_agents = 50, extra_agent_price = 2000,
                       van_price = 3000, photo_ai_monthly_quota = 200, photo_ai_extra_price = 2500
      WHERE code = 'enterprise'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE plans SET name = 'Base', monthly_price = 5000, included_agents = 10,
                       extra_agent_price = 500
      WHERE code = 'base'`);
    await q.query(`
      UPDATE plans SET name = 'Avancée', monthly_price = 15000, included_agents = 30,
                       extra_agent_price = 450
      WHERE code = 'advanced'`);
    await q.query(`
      UPDATE plans SET monthly_price = 40000, included_agents = 100, extra_agent_price = 400,
                       photo_ai_monthly_quota = 500, photo_ai_extra_price = 0
      WHERE code = 'enterprise'`);
    await q.query(`DROP TABLE one_time_charges`);
    await q.query(`
      ALTER TABLE invoices
        DROP COLUMN van_count, DROP COLUMN van_price, DROP COLUMN photo_ai_lots,
        DROP COLUMN photo_ai_lot_price, DROP COLUMN one_time_amount, DROP COLUMN lines`);
    await q.query(
      `ALTER TABLE platform_settings DROP COLUMN onboarding_packages`,
    );
    await q.query(`ALTER TABLE tenant_settings DROP COLUMN photo_ai_overage`);
    await q.query(`
      ALTER TABLE subscriptions
        DROP COLUMN legacy_until, DROP COLUMN legacy_monthly_price,
        DROP COLUMN legacy_included_agents, DROP COLUMN legacy_included_leads,
        DROP COLUMN legacy_extra_agent_price, DROP COLUMN legacy_photo_ai_quota,
        DROP COLUMN legacy_notified_at`);
    await q.query(`ALTER TABLE plans DROP COLUMN van_price`);
  }
}
