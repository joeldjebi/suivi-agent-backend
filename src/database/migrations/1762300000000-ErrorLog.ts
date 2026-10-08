import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Journal des erreurs de la plateforme (API, site web, app mobile), regroupées par erreur
 * identique, consulté par l'éditeur dans sa console. Table de la plateforme : pas
 * d'accès par structure.
 */
export class ErrorLog1762300000000 implements MigrationInterface {
  name = 'ErrorLog1762300000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(`
      CREATE TABLE platform_errors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        fingerprint text NOT NULL UNIQUE,
        source text NOT NULL CHECK (source IN ('api', 'web', 'mobile')),
        message text NOT NULL,
        route text,
        stack text,
        app_version text,
        count integer NOT NULL DEFAULT 1,
        tenants uuid[] NOT NULL DEFAULT '{}',
        last_tenant_id uuid,
        last_user_id uuid,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz
      )`);
    await q.query(
      `CREATE INDEX platform_errors_seen_idx ON platform_errors (last_seen_at DESC)`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON platform_errors TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE platform_errors`);
  }
}
