import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Validation des inscriptions par l'éditeur. Une structure qui s'inscrit arrive « en attente » :
 * elle ne peut rien faire tant que l'éditeur ne l'a pas validée (l'essai démarre à la validation).
 * Toutes les structures déjà présentes sont marquées « validées » pour ne pas les bloquer.
 */
export class TenantApproval1765200000000 implements MigrationInterface {
  name = 'TenantApproval1765200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tenants
        ADD COLUMN approval_status text NOT NULL DEFAULT 'approved'
          CHECK (approval_status IN ('pending', 'approved', 'rejected')),
        ADD COLUMN approved_at timestamptz,
        ADD COLUMN approved_by uuid,
        ADD COLUMN rejection_reason text`);
    // Les structures existantes gardent le défaut 'approved'. Le défaut reste 'approved'
    // (une création par l'éditeur est validée d'office) ; l'inscription publique pose 'pending'.
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE tenants
        DROP COLUMN approval_status,
        DROP COLUMN approved_at,
        DROP COLUMN approved_by,
        DROP COLUMN rejection_reason`,
    );
  }
}
