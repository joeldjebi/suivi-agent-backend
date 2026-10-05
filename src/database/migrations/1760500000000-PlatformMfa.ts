import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Double authentification des comptes éditeur : secret TOTP chiffré, codes de secours
 * (empreintes) et dernier pas de temps utilisé (un code ne sert qu'une fois).
 */
export class PlatformMfa1760500000000 implements MigrationInterface {
  name = 'PlatformMfa1760500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE platform_admins
        ADD COLUMN mfa_secret text,
        ADD COLUMN mfa_enabled_at timestamptz,
        ADD COLUMN mfa_recovery_codes text[] NOT NULL DEFAULT '{}',
        ADD COLUMN mfa_last_step bigint`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE platform_admins
        DROP COLUMN mfa_secret, DROP COLUMN mfa_enabled_at,
        DROP COLUMN mfa_recovery_codes, DROP COLUMN mfa_last_step`);
  }
}
