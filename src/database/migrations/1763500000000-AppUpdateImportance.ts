import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Importance de la dernière version de l'app (mineure : bandeau ; recommandée : fenêtre
 * à l'ouverture ; critique : mise à jour obligatoire) et texte des nouveautés.
 */
export class AppUpdateImportance1763500000000 implements MigrationInterface {
  name = 'AppUpdateImportance1763500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE platform_settings
        ADD COLUMN app_update_importance text NOT NULL DEFAULT 'minor'
          CHECK (app_update_importance IN ('minor', 'recommended', 'critical')),
        ADD COLUMN app_release_notes text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE platform_settings
        DROP COLUMN app_update_importance, DROP COLUMN app_release_notes`);
  }
}
