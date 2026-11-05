import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deux nouvelles fonctionnalités de formule, choisies par l'éditeur dans sa console :
 * - « van_sales » : vente en camionnette (demande la prise de commande) ;
 * - « photo_ai » : analyse des photos de rayon par IA (demande les relevés produits), avec un
 *   quota mensuel de photos par formule et un prix par lot de 100 photos au-delà.
 * Ajoutées à la formule Entreprise, comme les modules précédents.
 */
export class VanSalesPhotoAi1764200000000 implements MigrationInterface {
  name = 'VanSalesPhotoAi1764200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE plans
        ADD COLUMN photo_ai_monthly_quota integer NOT NULL DEFAULT 0 CHECK (photo_ai_monthly_quota >= 0),
        ADD COLUMN photo_ai_extra_price integer NOT NULL DEFAULT 0 CHECK (photo_ai_extra_price >= 0)`);
    for (const feature of ['van_sales', 'photo_ai']) {
      await q.query(
        `UPDATE plans SET features = array_append(features, $1)
         WHERE code = 'enterprise' AND NOT ($1 = ANY(features))`,
        [feature],
      );
    }
    await q.query(
      `UPDATE plans SET photo_ai_monthly_quota = 500 WHERE code = 'enterprise'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE plans SET features = array_remove(array_remove(features, 'van_sales'), 'photo_ai')`,
    );
    await q.query(
      `ALTER TABLE plans DROP COLUMN photo_ai_monthly_quota, DROP COLUMN photo_ai_extra_price`,
    );
  }
}
