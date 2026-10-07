import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durée de travail attendue par jour : celle de la structure (8 h par défaut), ou celle d'un
 * groupe, ou celle d'un agent (temps partiel). L'app et les bilans l'affichent comme objectif.
 */
export class WorkdayDuration1761600000000 implements MigrationInterface {
  name = 'WorkdayDuration1761600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tenant_settings
        ADD COLUMN workday_minutes integer NOT NULL DEFAULT 480
          CHECK (workday_minutes BETWEEN 30 AND 1440)`);
    await q.query(`
      ALTER TABLE groups
        ADD COLUMN workday_minutes integer CHECK (workday_minutes BETWEEN 30 AND 1440)`);
    await q.query(`
      ALTER TABLE users
        ADD COLUMN workday_minutes integer CHECK (workday_minutes BETWEEN 30 AND 1440)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE users DROP COLUMN workday_minutes`);
    await q.query(`ALTER TABLE groups DROP COLUMN workday_minutes`);
    await q.query(`ALTER TABLE tenant_settings DROP COLUMN workday_minutes`);
  }
}
