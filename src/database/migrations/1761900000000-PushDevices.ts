import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Téléphones joignables par notification push (Firebase Cloud Messaging). Un jeton
 * appartient à un seul compte à la fois : il est réattribué si un autre compte se connecte
 * sur le même téléphone. Table interne au service d'envoi (pas d'accès par structure).
 */
export class PushDevices1761900000000 implements MigrationInterface {
  name = 'PushDevices1761900000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(`
      CREATE TABLE push_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token text NOT NULL UNIQUE,
        platform text NOT NULL CHECK (platform IN ('android', 'ios')),
        app_version text,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX push_devices_user_idx ON push_devices (user_id)`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON push_devices TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE push_devices`);
  }
}
