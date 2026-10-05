import { MigrationInterface, QueryRunner } from 'typeorm';

/** Guide « Bien démarrer » : étapes cochées à la main et guide masqué. */
export class Onboarding1761300000000 implements MigrationInterface {
  name = 'Onboarding1761300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE tenant_settings ADD COLUMN onboarding jsonb NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE tenant_settings DROP COLUMN onboarding`);
  }
}
