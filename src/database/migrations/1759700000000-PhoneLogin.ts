import { MigrationInterface, QueryRunner } from 'typeorm';

/** Connexion par numéro de téléphone : numéros normalisés et uniques sur la plateforme. */
export class PhoneLogin1759700000000 implements MigrationInterface {
  name = 'PhoneLogin1759700000000';

  public async up(q: QueryRunner): Promise<void> {
    // Normalisation des numéros existants (même règle que common/phone.ts).
    await q.query(`
      UPDATE users SET phone = CASE
        WHEN cleaned = '' THEN NULL
        WHEN cleaned LIKE '+%' THEN cleaned
        WHEN cleaned LIKE '00%' THEN '+' || substr(cleaned, 3)
        ELSE '+225' || cleaned END
      FROM (SELECT id AS uid, regexp_replace(coalesce(phone, ''), '[\\s.()-]', '', 'g') AS cleaned FROM users) c
      WHERE c.uid = users.id AND users.phone IS NOT NULL`);
    await q.query(
      `CREATE UNIQUE INDEX users_phone_key ON users (phone) WHERE phone IS NOT NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX users_phone_key`);
  }
}
