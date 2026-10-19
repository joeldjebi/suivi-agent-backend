import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Positions suspectes repérées par le serveur (déplacement impossible : application de
 * fausse position, y compris sur la version web où le téléphone ne le signale pas).
 */
export class SuspectPositions1763900000000 implements MigrationInterface {
  name = 'SuspectPositions1763900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE positions ADD COLUMN suspect jsonb`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE positions DROP COLUMN suspect`);
  }
}
