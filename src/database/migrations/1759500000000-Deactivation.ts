import { MigrationInterface, QueryRunner } from 'typeorm';

/** Désactivation réversible des groupes et des missions (avant toute suppression définitive). */
export class Deactivation1759500000000 implements MigrationInterface {
  name = 'Deactivation1759500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE groups ADD COLUMN is_active boolean NOT NULL DEFAULT true`,
    );
    await q.query(
      `ALTER TABLE missions ADD COLUMN is_active boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE missions DROP COLUMN is_active`);
    await q.query(`ALTER TABLE groups DROP COLUMN is_active`);
  }
}
