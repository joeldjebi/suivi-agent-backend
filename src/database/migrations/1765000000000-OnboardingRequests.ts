import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Demandes de mise en place faites par une structure depuis sa page Abonnement : le forfait
 * (nom et prix figés au moment de la demande), un message, puis la décision de l'éditeur.
 * Acceptée, elle ajoute des frais ponctuels (one_time_charges) à la prochaine facture.
 */
export class OnboardingRequests1765000000000 implements MigrationInterface {
  name = 'OnboardingRequests1765000000000';

  public async up(q: QueryRunner): Promise<void> {
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(`
      CREATE TABLE onboarding_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        package_code text NOT NULL,
        package_name text NOT NULL,
        package_price integer NOT NULL CHECK (package_price >= 0),
        message text,
        status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
        requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz,
        decided_by text,
        decision_note text,
        amount integer,
        charge_id uuid REFERENCES one_time_charges(id) ON DELETE SET NULL
      )`);
    // Une seule demande en attente par structure.
    await q.query(
      `CREATE UNIQUE INDEX onboarding_requests_pending_idx ON onboarding_requests (tenant_id) WHERE status = 'pending'`,
    );
    await q.query(
      `CREATE INDEX onboarding_requests_status_idx ON onboarding_requests (status, created_at DESC)`,
    );
    await q.query(`ALTER TABLE onboarding_requests ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE onboarding_requests FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON onboarding_requests USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_requests TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE onboarding_requests`);
  }
}
