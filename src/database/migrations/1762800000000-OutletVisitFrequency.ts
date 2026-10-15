import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fréquence de visite des points de vente : celle de chaque point de vente, sinon celle de la
 * structure (30 jours par défaut, 0 = pas de suivi). Les responsables sont prévenus chaque
 * matin des points de vente en retard (date du dernier avis gardée pour n'en envoyer qu'un).
 */
export class OutletVisitFrequency1762800000000 implements MigrationInterface {
  name = 'OutletVisitFrequency1762800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE outlets ADD COLUMN visit_frequency_days integer CHECK (visit_frequency_days > 0)`,
    );
    await q.query(`
      ALTER TABLE tenant_settings
        ADD COLUMN outlet_visit_frequency_days integer NOT NULL DEFAULT 30,
        ADD COLUMN outlets_overdue_notified_on date`);
    // Dernière visite d'un point de vente : lue souvent (listes, retards, tournées).
    await q.query(
      `CREATE INDEX mission_submissions_outlet_visit_idx ON mission_submissions (outlet_id, submitted_at DESC) WHERE status = 'accepted' AND outlet_id IS NOT NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX mission_submissions_outlet_visit_idx`);
    await q.query(
      `ALTER TABLE tenant_settings DROP COLUMN outlet_visit_frequency_days, DROP COLUMN outlets_overdue_notified_on`,
    );
    await q.query(`ALTER TABLE outlets DROP COLUMN visit_frequency_days`);
  }
}
