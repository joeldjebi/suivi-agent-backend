import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Version de l'app mobile : en dessous de la version minimale, l'app est invitée à se
 * mettre à jour (liens des boutiques), réglée par l'éditeur.
 */
export class AppVersion1762200000000 implements MigrationInterface {
  name = 'AppVersion1762200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE platform_settings
        ADD COLUMN min_app_version text,
        ADD COLUMN latest_app_version text,
        ADD COLUMN android_store_url text,
        ADD COLUMN ios_store_url text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE platform_settings
        DROP COLUMN min_app_version, DROP COLUMN latest_app_version,
        DROP COLUMN android_store_url, DROP COLUMN ios_store_url`);
  }
}
