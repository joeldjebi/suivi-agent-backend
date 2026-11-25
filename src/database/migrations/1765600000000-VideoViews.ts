import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Suivi des lectures de la vidéo de présentation (page publique /video) : qui (prospect si
 * lien personnalisé), où (via l'IP), et le temps regardé. Table de plateforme (pas de tenant).
 */
export class VideoViews1765600000000 implements MigrationInterface {
  name = 'VideoViews1765600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE video_views (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        view_id text NOT NULL UNIQUE,
        prospect_id uuid REFERENCES prospects(id) ON DELETE SET NULL,
        seconds int NOT NULL DEFAULT 0,
        percent int NOT NULL DEFAULT 0,
        duration int,
        orientation text,
        ip text,
        user_agent text,
        referer text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX video_views_updated_idx ON video_views (updated_at DESC)`,
    );
    await q.query(
      `CREATE INDEX video_views_prospect_idx ON video_views (prospect_id)`,
    );
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(
      `GRANT SELECT, INSERT, UPDATE ON video_views TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE video_views`);
  }
}
