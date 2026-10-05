import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Onboarding de l'app mobile réglé par l'éditeur : pages (titre, texte, animation fournie ou
 * Lottie importée) et version, augmentée pour le remontrer à tous. Données de la plateforme :
 * pas de Row Level Security.
 */
export class AppOnboarding1761400000000 implements MigrationInterface {
  name = 'AppOnboarding1761400000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(`
      CREATE TABLE app_onboarding (
        id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        enabled boolean NOT NULL DEFAULT true,
        version integer NOT NULL DEFAULT 1,
        initialized boolean NOT NULL DEFAULT false,
        published_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`INSERT INTO app_onboarding DEFAULT VALUES`);
    await q.query(`
      CREATE TABLE app_onboarding_slides (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        position integer NOT NULL,
        title text NOT NULL,
        body text NOT NULL,
        animation text NOT NULL,
        color text,
        lottie jsonb,
        lottie_name text,
        lottie_size integer,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON app_onboarding, app_onboarding_slides TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE app_onboarding_slides`);
    await q.query(`DROP TABLE app_onboarding`);
  }
}
