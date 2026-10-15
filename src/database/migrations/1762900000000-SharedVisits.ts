import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Socle commun aux modules Missions et Points de vente : un formulaire reçu porte son
 * formulaire (type) et peut ne pas avoir de mission (visite libre d'un point de vente). Les
 * deux modules partagent ainsi les mêmes formulaires, relevés et visites, seuls ou ensemble.
 */
export class SharedVisits1762900000000 implements MigrationInterface {
  name = 'SharedVisits1762900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE mission_submissions ADD COLUMN type_id uuid REFERENCES mission_types(id) ON DELETE CASCADE`,
    );
    await q.query(`
      UPDATE mission_submissions s SET type_id = m.type_id
      FROM missions m WHERE m.id = s.mission_id`);
    await q.query(
      `ALTER TABLE mission_submissions ALTER COLUMN type_id SET NOT NULL`,
    );
    await q.query(
      `ALTER TABLE mission_submissions ALTER COLUMN mission_id DROP NOT NULL`,
    );
    await q.query(
      `CREATE INDEX mission_submissions_type_idx ON mission_submissions (type_id, submitted_at)`,
    );
    await q.query(
      `ALTER TABLE product_readings ALTER COLUMN mission_id DROP NOT NULL`,
    );
    // Formulaires proposés pour visiter un point de vente sans mission.
    await q.query(
      `ALTER TABLE tenant_settings ADD COLUMN outlet_visit_type_ids uuid[] NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE tenant_settings DROP COLUMN outlet_visit_type_ids`,
    );
    await q.query(`DELETE FROM product_readings WHERE mission_id IS NULL`);
    await q.query(
      `ALTER TABLE product_readings ALTER COLUMN mission_id SET NOT NULL`,
    );
    await q.query(`DELETE FROM mission_submissions WHERE mission_id IS NULL`);
    await q.query(
      `ALTER TABLE mission_submissions ALTER COLUMN mission_id SET NOT NULL`,
    );
    await q.query(`ALTER TABLE mission_submissions DROP COLUMN type_id`);
  }
}
