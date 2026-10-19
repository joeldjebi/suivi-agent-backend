import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Suivi continu obligatoire : la journée ne démarre que depuis l'app mobile (le navigateur
 * coupe le GPS écran éteint). Désactivé par défaut.
 */
export class RequireMobileTracking1763800000000 implements MigrationInterface {
  name = 'RequireMobileTracking1763800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE tenant_settings ADD COLUMN require_mobile_tracking boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE tenant_settings DROP COLUMN require_mobile_tracking`,
    );
  }
}
