import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications push : fonctionnalité des formules Avancée et Entreprise (l'éditeur l'ajoute
 * ou la retire ensuite depuis sa console).
 */
export class PushFeature1761950000000 implements MigrationInterface {
  name = 'PushFeature1761950000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE plans SET features = array_append(features, 'push_notifications')
      WHERE code IN ('advanced', 'enterprise') AND NOT ('push_notifications' = ANY(features))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE plans SET features = array_remove(features, 'push_notifications')`,
    );
  }
}
