import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reprise de la journée : un agent qui a terminé sa journée et redémarre le même jour
 * reprend la même journée. L'interruption devient une pause marquée « day_ended »
 * (« terminée à 13 h 05 · reprise à 14 h 20 ») : elle n'est pas comptée comme travaillée.
 */
export class DayResume1763200000000 implements MigrationInterface {
  name = 'DayResume1763200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE day_pauses ADD COLUMN reason text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE day_pauses DROP COLUMN reason`);
  }
}
