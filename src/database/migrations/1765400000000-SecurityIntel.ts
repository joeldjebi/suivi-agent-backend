import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enrichissement du journal de sécurité : méthode HTTP et referer de chaque tentative, et
 * une table cache des renseignements d'adresse IP (pays, ville, opérateur…) obtenus auprès
 * d'ipinfo.io, pour ne pas réinterroger la même adresse à chaque affichage.
 */
export class SecurityIntel1765400000000 implements MigrationInterface {
  name = 'SecurityIntel1765400000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(
      `ALTER TABLE security_events ADD COLUMN method text, ADD COLUMN referer text`,
    );
    // Le GRANT sur la table couvre déjà les nouvelles colonnes.
    await q.query(`
      CREATE TABLE ip_intel (
        ip text PRIMARY KEY,
        country text,
        region text,
        city text,
        loc text,
        org text,
        postal text,
        timezone text,
        hostname text,
        privacy jsonb,
        fetched_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ip_intel TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE ip_intel`);
    await q.query(
      `ALTER TABLE security_events DROP COLUMN method, DROP COLUMN referer`,
    );
  }
}
