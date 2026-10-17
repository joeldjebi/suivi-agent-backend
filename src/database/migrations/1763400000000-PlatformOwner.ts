import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Compte éditeur propriétaire : le seul à pouvoir désactiver ou supprimer les autres
 * comptes, et que personne ne peut supprimer. Au départ, le plus ancien compte actif.
 */
export class PlatformOwner1763400000000 implements MigrationInterface {
  name = 'PlatformOwner1763400000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(
      `ALTER TABLE platform_admins ADD COLUMN is_owner boolean NOT NULL DEFAULT false`,
    );
    await q.query(
      `CREATE UNIQUE INDEX platform_admins_owner_idx ON platform_admins (is_owner) WHERE is_owner`,
    );
    await q.query(`
      UPDATE platform_admins SET is_owner = true
      WHERE id = (SELECT id FROM platform_admins ORDER BY is_active DESC, created_at ASC LIMIT 1)`);
    // Suppression d'un compte éditeur par le propriétaire.
    await q.query(`GRANT DELETE ON platform_admins TO ${appUser}`);
  }

  public async down(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(`REVOKE DELETE ON platform_admins FROM ${appUser}`);
    await q.query(`DROP INDEX platform_admins_owner_idx`);
    await q.query(`ALTER TABLE platform_admins DROP COLUMN is_owner`);
  }
}
