import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * IA photo : fournisseur choisi par l'éditeur (Anthropic ou Mistral AI, ou aucun). Les clés
 * restent dans la configuration du serveur ; seul le choix est ici.
 */
export class PhotoAiProvider1764600000000 implements MigrationInterface {
  name = 'PhotoAiProvider1764600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE platform_settings ADD COLUMN photo_ai_provider text NOT NULL DEFAULT 'anthropic'
         CHECK (photo_ai_provider IN ('anthropic', 'mistral', 'off'))`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE platform_settings DROP COLUMN photo_ai_provider`,
    );
  }
}
