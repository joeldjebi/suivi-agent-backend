import { MigrationInterface, QueryRunner } from 'typeorm';

/** Photo de profil : image stockée en base, version pour le cache des applications. */
export class Avatar1759800000000 implements MigrationInterface {
  name = 'Avatar1759800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE users
        ADD COLUMN avatar bytea,
        ADD COLUMN avatar_mime text,
        ADD COLUMN avatar_version integer`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE users
        DROP COLUMN avatar,
        DROP COLUMN avatar_mime,
        DROP COLUMN avatar_version`);
  }
}
