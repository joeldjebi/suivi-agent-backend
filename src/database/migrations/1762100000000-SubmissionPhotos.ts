import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Photos des formulaires, prises sur le terrain : envoyées avant le formulaire (hors ligne,
 * elles attendent le réseau avec lui), avec leur position et leur heure de prise. Le
 * formulaire n'en garde que l'identifiant.
 */
export class SubmissionPhotos1762100000000 implements MigrationInterface {
  name = 'SubmissionPhotos1762100000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(`
      CREATE TABLE submission_photos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id uuid NOT NULL,
        submission_id uuid REFERENCES mission_submissions(id) ON DELETE CASCADE,
        data bytea NOT NULL,
        mime text NOT NULL,
        size integer NOT NULL,
        lat double precision,
        lng double precision,
        accuracy double precision,
        taken_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (agent_id, client_id)
      )`);
    await q.query(
      `CREATE INDEX submission_photos_submission_idx ON submission_photos (submission_id)`,
    );
    await q.query(`ALTER TABLE submission_photos ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE submission_photos FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON submission_photos USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON submission_photos TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE submission_photos`);
  }
}
