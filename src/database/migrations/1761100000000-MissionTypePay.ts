import { MigrationInterface, QueryRunner } from 'typeorm';

/** Conditions de rémunération d'un type de mission (vide : grille de l'agent). */
export class MissionTypePay1761100000000 implements MigrationInterface {
  name = 'MissionTypePay1761100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE mission_types ADD COLUMN pay jsonb`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE mission_types DROP COLUMN pay`);
  }
}
