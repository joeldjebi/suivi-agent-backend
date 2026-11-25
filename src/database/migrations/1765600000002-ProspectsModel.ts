import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enrichit le modèle de prospection : badge « prioritaire », liens (site, réseaux sociaux),
 * prochaine action (date + note), date du dernier contact. Remappe aussi les anciens statuts
 * vers le nouveau jeu (à contacter / contacté / à relancer / rendez-vous / démo faite / client
 * / pas intéressé).
 */
const PRIORITAIRES = [
  'Advans Côte d’Ivoire',
  'Baobab Côte d’Ivoire',
  'COFINA Côte d’Ivoire',
  'UNACOOPEC-CI',
  'Orange Money CI',
  'MTN MoMo CI',
  'Jumia Côte d’Ivoire',
  'Glovo Côte d’Ivoire',
  'Groupe Prosuma',
  'SOLIBRA (Castel)',
  'Continental Security / G4S CI',
  'Wave Sénégal',
];

export class ProspectsModel1765600000002 implements MigrationInterface {
  name = 'ProspectsModel1765600000002';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE prospects
        ADD COLUMN IF NOT EXISTS site text,
        ADD COLUMN IF NOT EXISTS facebook text,
        ADD COLUMN IF NOT EXISTS instagram text,
        ADD COLUMN IF NOT EXISTS linkedin text,
        ADD COLUMN IF NOT EXISTS prioritaire boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS prochaine_action_date date,
        ADD COLUMN IF NOT EXISTS prochaine_action_note text,
        ADD COLUMN IF NOT EXISTS dernier_contact timestamptz`);

    // Remappage des anciens statuts.
    await q.query(`UPDATE prospects SET statut = 'a_relancer' WHERE statut = 'relance'`);
    await q.query(`UPDATE prospects SET statut = 'contacte' WHERE statut = 'interesse'`);
    await q.query(`UPDATE prospects SET statut = 'client' WHERE statut = 'gagne'`);
    await q.query(`UPDATE prospects SET statut = 'pas_interesse' WHERE statut = 'perdu'`);

    // Lot prioritaire.
    await q.query(`UPDATE prospects SET prioritaire = true WHERE entreprise = ANY($1)`, [PRIORITAIRES]);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE prospects
        DROP COLUMN IF EXISTS site,
        DROP COLUMN IF EXISTS facebook,
        DROP COLUMN IF EXISTS instagram,
        DROP COLUMN IF EXISTS linkedin,
        DROP COLUMN IF EXISTS prioritaire,
        DROP COLUMN IF EXISTS prochaine_action_date,
        DROP COLUMN IF EXISTS prochaine_action_note,
        DROP COLUMN IF EXISTS dernier_contact`);
  }
}
