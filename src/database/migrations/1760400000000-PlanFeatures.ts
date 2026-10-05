import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Catalogue réglé par l'éditeur : chaque formule porte ses fonctionnalités (avantages),
 * l'éditeur crée ses propres formules et choisit celles de l'essai et de l'après-essai.
 */
export class PlanFeatures1760400000000 implements MigrationInterface {
  name = 'PlanFeatures1760400000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(
      `ALTER TABLE plans ADD COLUMN features text[] NOT NULL DEFAULT '{}'`,
    );
    await q.query(`
      UPDATE plans SET features = v.features
      FROM (VALUES
        ('base', ARRAY[]::text[]),
        ('advanced', ARRAY['groups', 'manual_approval', 'missions', 'branding', 'exports']),
        ('enterprise', ARRAY['groups', 'manual_approval', 'missions', 'branding', 'exports',
                             'stats', 'team_leads', 'audit', 'payroll'])
      ) AS v(code, features)
      WHERE plans.code = v.code`);
    await q.query(`
      ALTER TABLE plans
        ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()`);
    // Formule dont l'essai prend les quotas, et formule attribuée à la fin de l'essai.
    await q.query(`
      ALTER TABLE platform_settings
        ADD COLUMN trial_plan_code text NOT NULL DEFAULT 'enterprise' REFERENCES plans(code),
        ADD COLUMN default_plan_code text NOT NULL DEFAULT 'advanced' REFERENCES plans(code)`);
    await q.query(`GRANT INSERT, DELETE ON plans TO ${appUser}`);
  }

  public async down(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(`REVOKE INSERT, DELETE ON plans FROM ${appUser}`);
    await q.query(`
      ALTER TABLE platform_settings DROP COLUMN trial_plan_code, DROP COLUMN default_plan_code`);
    await q.query(
      `ALTER TABLE plans DROP COLUMN features, DROP COLUMN created_at, DROP COLUMN updated_at`,
    );
  }
}
