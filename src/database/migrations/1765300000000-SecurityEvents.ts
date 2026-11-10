import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Journal des événements de sécurité (« attaques » visibles par l'éditeur) : mots de passe
 * refusés, verrouillages, dépassements de débit, échecs CAPTCHA, pièges à robots. Table de
 * plateforme (pas de tenant) : la plupart des événements sont anonymes (avant connexion).
 * Lue uniquement par l'éditeur ; écrite par le serveur. Purge au-delà de 90 jours (tâche).
 */
export class SecurityEvents1765300000000 implements MigrationInterface {
  name = 'SecurityEvents1765300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE security_events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        type text NOT NULL,
        ip text,
        target text,
        path text,
        user_agent text,
        tenant_id uuid,
        details jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX security_events_created_idx ON security_events (created_at DESC)`,
    );
    await q.query(
      `CREATE INDEX security_events_type_created_idx ON security_events (type, created_at DESC)`,
    );
    await q.query(
      `CREATE INDEX security_events_ip_created_idx ON security_events (ip, created_at DESC)`,
    );
    // L'API se connecte avec un rôle non-propriétaire (pour la RLS) : on lui donne les droits.
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(
      `GRANT SELECT, INSERT, DELETE ON security_events TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE security_events`);
  }
}
