import { MigrationInterface, QueryRunner } from 'typeorm';

/** Conditions de rémunération propres à une mission (vide : grille de l'agent). */
export class MissionPay1760800000000 implements MigrationInterface {
  name = 'MissionPay1760800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE missions ADD COLUMN pay jsonb`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE missions DROP COLUMN pay`);
  }
}
