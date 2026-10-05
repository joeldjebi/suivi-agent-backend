import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rémunération des agents et des chefs d'équipe (formule Entreprise) : grilles, paies par
 * période (brouillon calculé automatiquement → validée → payée), lignes et ajustements.
 * Aucun paiement ne passe par la plateforme : export puis marquage « payé ».
 */
export class Payroll1760200000000 implements MigrationInterface {
  name = 'Payroll1760200000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;

    await q.query(`
      CREATE TABLE pay_settings (
        tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        period text NOT NULL DEFAULT 'monthly',
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE pay_grids (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name text NOT NULL,
        components jsonb NOT NULL DEFAULT '{}',
        targets jsonb NOT NULL DEFAULT '{}',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE pay_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        period text NOT NULL,
        period_start date NOT NULL,
        period_end date NOT NULL,
        status text NOT NULL DEFAULT 'draft',
        computed_at timestamptz NOT NULL DEFAULT now(),
        validated_at timestamptz,
        validated_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
        paid_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, period_start, period_end)
      )`);
    await q.query(`
      CREATE TABLE pay_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        run_id uuid NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        grid_id uuid REFERENCES pay_grids(id) ON DELETE SET NULL,
        grid_name text,
        items jsonb NOT NULL DEFAULT '[]',
        gross integer NOT NULL DEFAULT 0,
        adjustments integer NOT NULL DEFAULT 0,
        total integer NOT NULL DEFAULT 0,
        paid_at timestamptz,
        payment_reference text,
        UNIQUE (run_id, user_id)
      )`);
    await q.query(`
      CREATE TABLE pay_adjustments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        run_id uuid NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount integer NOT NULL,
        reason text NOT NULL,
        status text NOT NULL,
        proposed_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
        decided_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
        decided_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX pay_lines_user_idx ON pay_lines (user_id)`);
    await q.query(
      `CREATE INDEX pay_adjustments_run_idx ON pay_adjustments (run_id, user_id)`,
    );
    for (const table of [
      'pay_settings',
      'pay_grids',
      'pay_runs',
      'pay_lines',
      'pay_adjustments',
    ]) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(
        `CREATE POLICY tenant_isolation ON ${table} USING (${policy}) WITH CHECK (${policy})`,
      );
      await q.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${appUser}`,
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of [
      'pay_adjustments',
      'pay_lines',
      'pay_runs',
      'pay_grids',
      'pay_settings',
    ])
      await q.query(`DROP TABLE ${table}`);
  }
}
