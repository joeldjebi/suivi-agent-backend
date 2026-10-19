import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Support de la journée (app mobile iPhone ou Android, ou version web) : sur le web, le
 * navigateur coupe le GPS écran éteint ; l'alerte « signal perdu » le dit au responsable.
 */
export class DayClient1763600000000 implements MigrationInterface {
  name = 'DayClient1763600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE work_days
        ADD COLUMN client text CHECK (client IN ('web', 'ios', 'android'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE work_days DROP COLUMN client`);
  }
}
