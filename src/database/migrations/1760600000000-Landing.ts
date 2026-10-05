import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Site vitrine réglé par l'éditeur : contenu en brouillon puis publié, images, et demandes
 * de démo reçues depuis le site. Données de la plateforme : pas de Row Level Security.
 */
export class Landing1760600000000 implements MigrationInterface {
  name = 'Landing1760600000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(`
      CREATE TABLE landing_pages (
        id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        draft jsonb,
        published jsonb,
        published_at timestamptz,
        published_by text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      )`);
    await q.query(`INSERT INTO landing_pages DEFAULT VALUES`);
    await q.query(`
      CREATE TABLE landing_assets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        mime text NOT NULL,
        data bytea NOT NULL,
        size integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by text
      )`);
    await q.query(`
      CREATE TABLE demo_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        organization text NOT NULL,
        email text NOT NULL,
        phone text NOT NULL,
        agents integer,
        message text,
        status text NOT NULL DEFAULT 'new',
        notes text,
        ip text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX demo_requests_status_idx ON demo_requests (status, created_at DESC)`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON landing_pages, landing_assets, demo_requests TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE demo_requests`);
    await q.query(`DROP TABLE landing_assets`);
    await q.query(`DROP TABLE landing_pages`);
  }
}
