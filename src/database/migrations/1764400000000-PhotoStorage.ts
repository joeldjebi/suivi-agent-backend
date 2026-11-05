import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Photos du terrain rangées hors de la base : chaque photo a une clé de fichier (dossier de
 * stockage) ; le contenu en base n'existe plus que pour les photos d'avant, recopiées dans le
 * dossier au démarrage de l'API puis effacées de la base.
 */
export class PhotoStorage1764400000000 implements MigrationInterface {
  name = 'PhotoStorage1764400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE submission_photos ADD COLUMN storage_key text`);
    await q.query(
      `ALTER TABLE submission_photos ALTER COLUMN data DROP NOT NULL`,
    );
    await q.query(
      `ALTER TABLE submission_photos ADD CONSTRAINT submission_photos_content
         CHECK (data IS NOT NULL OR storage_key IS NOT NULL)`,
    );
  }

  public down(): Promise<void> {
    // Pas de retour en arrière automatique : les photos sont dans le dossier de stockage.
    return Promise.reject(
      new Error(
        'Retour impossible : recopiez d’abord les photos du dossier dans la base',
      ),
    );
  }
}
