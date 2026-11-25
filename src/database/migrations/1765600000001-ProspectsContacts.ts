import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Complète les contacts du lot prioritaire (12 entreprises) avec des informations
 * PUBLIQUES et vérifiées (téléphones/e-mails trouvés sur les sites officiels ou annuaires
 * fiables). Aucun e-mail/numéro inventé : « non public » → champ laissé vide, canal = voie
 * fiable (formulaire du site / LinkedIn). Mise à jour par nom d'entreprise.
 */
const CONTACTS: {
  entreprise: string;
  contact: string;
  tel: string | null;
  email: string | null;
  canal: string;
  note: string;
}[] = [
  { entreprise: 'Advans Côte d’Ivoire', contact: 'Directeur commercial / du réseau', tel: '+225 05 75 58 45 84', email: 'serviceclient@advanscotedivoire.com', canal: 'Téléphone / WhatsApp / e-mail', note: ' · Standard +225 05 75 58 45 84, WhatsApp +225 05 75 58 45 60. Siège : Bd de Brazzaville, Marcory. Source : advanscotedivoire.com.' },
  { entreprise: 'Baobab Côte d’Ivoire', contact: 'Directeur commercial / du réseau', tel: null, email: null, canal: 'Formulaire site / LinkedIn', note: ' · Tél/e-mail non publics. Site : baobab.com/ci.' },
  { entreprise: 'COFINA Côte d’Ivoire', contact: 'Directeur commercial / du réseau', tel: null, email: null, canal: 'Formulaire site / LinkedIn', note: ' · Tél/e-mail non publics. Siège : Bd Latrille, II Plateaux Cocody. Site : cofinacotedivoire.com.' },
  { entreprise: 'UNACOOPEC-CI', contact: 'Directeur commercial / du réseau COOPEC', tel: '+225 27 22 40 49 99', email: null, canal: 'Téléphone (à confirmer) / LinkedIn', note: ' · N° d’annuaire à confirmer. Site : unacoopec.com.' },
  { entreprise: 'Orange Money CI', contact: 'Directeur Orange Money / commercial B2B', tel: null, email: null, canal: 'LinkedIn (page Orange CI)', note: ' · Pas de n° officiel vérifié. Site : orange.ci.' },
  { entreprise: 'MTN MoMo CI', contact: 'Directeur Mobile Financial Services', tel: null, email: null, canal: 'LinkedIn / mtn.ci', note: ' · Tél/e-mail non publics. Site : mtn.ci.' },
  { entreprise: 'Jumia Côte d’Ivoire', contact: 'Directeur commercial / des opérations', tel: '+225 25 20 00 61 61', email: null, canal: 'Téléphone / WhatsApp', note: ' · Tél + WhatsApp +225 25 20 00 61 61. Siège : Marcory Roche Bobois. Source : jumia.ci/contact.' },
  { entreprise: 'Glovo Côte d’Ivoire', contact: 'DG / Directeur des opérations', tel: null, email: null, canal: 'LinkedIn', note: ' · Pas d’e-mail commercial public (dpo@ = DPO). Siège : Marcory Zone 4C. Source : glovoapp.com.' },
  { entreprise: 'Groupe Prosuma', contact: 'Directeur commercial / de la distribution', tel: null, email: null, canal: 'Formulaire site / LinkedIn', note: ' · Tél/e-mail non publics. Siège : Zone 3, Treichville. Site : groupeprosuma.com.' },
  { entreprise: 'SOLIBRA (Castel)', contact: 'Directeur commercial / de la distribution', tel: '+225 27 21 21 12 00', email: null, canal: 'Téléphone', note: ' · Standard +225 27 21 21 12 00, service client 80 00 00 10. Siège : Zone 3, Treichville. Source : solibra.ci.' },
  { entreprise: 'Continental Security / G4S CI', contact: 'Directeur des opérations / commercial', tel: '+225 27 22 48 01 00', email: null, canal: 'Téléphone', note: ' · +225 27 22 48 01 00. Siège : Rue J 82, II Plateaux Vallon Cocody. Source : g4s.com/en-ci.' },
  { entreprise: 'Wave Sénégal', contact: 'Directeur commercial / des opérations', tel: null, email: null, canal: 'LinkedIn (page Wave)', note: ' · Service client 200 600 (à confirmer). Site : wave.com.' },
];

export class ProspectsContacts1765600000001 implements MigrationInterface {
  name = 'ProspectsContacts1765600000001';

  public async up(q: QueryRunner): Promise<void> {
    for (const c of CONTACTS) {
      await q.query(
        `UPDATE prospects
            SET contact_nom = $2,
                telephone = COALESCE($3, telephone),
                email = COALESCE($4, email),
                canal = $5,
                notes = COALESCE(notes, '') || $6,
                updated_at = now()
          WHERE entreprise = $1`,
        [c.entreprise, c.contact, c.tel, c.email, c.canal, c.note],
      );
    }
  }

  public async down(): Promise<void> {
    // Données éditoriales : pas de retour arrière.
  }
}
