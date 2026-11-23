import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pré-remplissage de la prospection avec une première liste d'entreprises cibles
 * (Côte d'Ivoire + sous-région UEMOA/CEDEAO), issue d'une recherche. Aucun e-mail ni numéro
 * n'est renseigné (non inventés) : seuls le secteur, le pays, le canal conseillé et une note.
 */
const PROSPECTS: [string, string, string, string, string, string][] = [
  ['Advans Côte d’Ivoire', 'Côte d’Ivoire', 'Microfinance (SFD)', 'Abidjan', 'LinkedIn', '19+ agences, agents de crédit et collecteurs en visite clients quotidienne. Site : advansgroup.com (à vérifier).'],
  ['COFINA Côte d’Ivoire', 'Côte d’Ivoire', 'Méso/microfinance', 'Abidjan', 'LinkedIn', 'Leader panafricain mésofinance, chargés de clientèle TPE/PME sur le terrain. groupecofina.com (à vérifier).'],
  ['Baobab Côte d’Ivoire', 'Côte d’Ivoire', 'Microfinance', 'Abidjan', 'LinkedIn', 'Réseau national, agents de prêt et recouvrement mobiles. baobab.com (à vérifier).'],
  ['UNACOOPEC-CI', 'Côte d’Ivoire', 'Microfinance coopérative', 'Abidjan', 'APSFD-CI / LinkedIn', 'Plus grand réseau mutualiste du pays, nombreux points de service et collecteurs.'],
  ['NSIA Assurances CI', 'Côte d’Ivoire', 'Assurance', 'Abidjan', 'LinkedIn / FANAF', 'Agents généraux + apporteurs d’affaires nombreux à suivre. groupensia.com (à vérifier).'],
  ['Sunu Assurances CI', 'Côte d’Ivoire', 'Assurance / micro-assurance', 'Abidjan', 'LinkedIn / FANAF', 'Distribution via microfinance + agents, offres micro-assurance. sunu-group.com (à vérifier).'],
  ['DPCI (Distribution Pharmaceutique de CI)', 'Côte d’Ivoire', 'Grossiste-répartiteur pharma', 'Abidjan (Treichville)', 'Courrier siège', 'Flotte de livraison + délégués, livraisons officines à tracer.'],
  ['Ubipharm / Laborex CI', 'Côte d’Ivoire', 'Grossiste-répartiteur pharma', 'Abidjan / Bouaké', 'LinkedIn', 'Grossiste répartiteur, flotte logistique et répartiteurs terrain. ubipharm.com (à vérifier).'],
  ['Groupe Prosuma', 'Côte d’Ivoire', 'Distribution / FMCG', 'Abidjan', 'LinkedIn', '~161 points de vente, merchandisers et superviseurs terrain. prosuma.ci (à vérifier).'],
  ['CDCI', 'Côte d’Ivoire', 'Distribution / FMCG', 'Abidjan', 'LinkedIn / annuaire', '121 magasins dans 40 villes, logistique et force de vente.'],
  ['SOLIBRA (Castel)', 'Côte d’Ivoire', 'Boisson / FMCG', 'Abidjan', 'LinkedIn', 'Force de vente terrain massive (CHR, détaillants). Cotée BRVM « SLBC ».'],
  ['Brassivoire (Heineken/CFAO)', 'Côte d’Ivoire', 'Boisson / FMCG', 'Abidjan', 'LinkedIn / CFAO', 'Force de vente et distribution nationale en forte croissance. brassivoire.ci (à vérifier).'],
  ['SDTM-CI / Carré d’Or', 'Côte d’Ivoire', 'Distribution (Coca-Cola, Unilever)', 'Abidjan', 'LinkedIn', 'Embouteillage + distribution nationale, grande force de vente terrain.'],
  ['Jumia Côte d’Ivoire', 'Côte d’Ivoire', 'Logistique / e-commerce', 'Abidjan', 'LinkedIn / formulaire pro', 'Coursiers + 6 dark stores, livraison à tracer en temps réel. jumia.ci (confirmé).'],
  ['Glovo Côte d’Ivoire', 'Côte d’Ivoire', 'Livraison', 'Abidjan', 'LinkedIn / site pro', 'Plusieurs centaines de coursiers actifs depuis 2019. glovoapp.com (confirmé).'],
  ['Yango Delivery CI', 'Côte d’Ivoire', 'Livraison', 'Abidjan', 'LinkedIn', '200+ coursiers, besoin de dispatch/preuve de livraison. yango.com (à vérifier).'],
  ['Orange Money CI', 'Côte d’Ivoire', 'Télécoms / mobile money', 'Abidjan', 'LinkedIn', '~40 000 kiosques/agents, animateurs et superviseurs réseau. orange.ci (confirmé).'],
  ['MTN MoMo CI', 'Côte d’Ivoire', 'Télécoms / mobile money', 'Abidjan', 'LinkedIn', 'Distributeurs et animateurs terrain à encadrer. mtn.ci (à vérifier).'],
  ['ATOM BTL', 'Côte d’Ivoire', 'Marketing terrain / BTL', 'Abidjan (Yopougon)', 'LinkedIn / GoAfrica', 'Déploie des équipes de merchandisers (jusqu’à 650 agents sur une activation).'],
  ['ALL’Marketing', 'Côte d’Ivoire', 'Marketing terrain', 'Abidjan (Cocody)', 'LinkedIn / GoAfrica', 'Animateurs et promoteurs en magasin et hors magasin.'],
  ['Djembey', 'Côte d’Ivoire', 'Street marketing / activation', 'Abidjan', 'LinkedIn / GoAfrica', 'Roadshows, caravanes, animations : agents terrain dispersés.'],
  ['Continental Security / G4S CI', 'Côte d’Ivoire', 'Sécurité / gardiennage', 'Abidjan', 'LinkedIn', '850+ agents (Continental) ; rondes à pointer par GPS/preuve photo.'],
  ['ACEP Sénégal', 'Sénégal', 'Microfinance', 'Dakar', 'LinkedIn / APIM', 'Leader SFD, agents de crédit en visite terrain + comité de crédit. acep.sn (à vérifier).'],
  ['Baobab Sénégal', 'Sénégal', 'Microfinance', 'Dakar', 'LinkedIn', 'Couverture nationale, agents de prêt et recouvrement. baobab.com (à vérifier).'],
  ['PAMECAS', 'Sénégal', 'Microfinance coopérative', 'Dakar', 'APIM / LinkedIn', 'Grand réseau mutualiste, nombreux points et collecteurs.'],
  ['U-IMCEC', 'Sénégal', 'Microfinance', 'Dakar', 'LinkedIn / APIM', 'Réseau coopératif, agents terrain.'],
  ['Wave Sénégal', 'Sénégal', 'Mobile money / fintech', 'Dakar', 'LinkedIn', '~13 000 agents + équipes jeunes terrain à animer. wave.com (confirmé).'],
  ['Paps', 'Sénégal', 'Logistique / livraison', 'Dakar', 'LinkedIn', 'Flotte ~600 véhicules partenaires, livraison 100% digitalisée. paps.sn (à vérifier).'],
  ['Yobante Express', 'Sénégal', 'Livraison dernier km', 'Dakar', 'LinkedIn', 'Réseau de coursiers indépendants + points relais à suivre.'],
  ['Kafo Jiginew', 'Mali', 'Microfinance coopérative agricole', 'Sikasso / Bamako', 'LinkedIn / APIM', 'Très grand réseau rural, agents de crédit en zones agricoles.'],
  ['Nyèsigiso', 'Mali', 'Microfinance coopérative', 'Bamako', 'LinkedIn / SIDI', '~400 000 clients, réseau national, agents mobiles. nyesigiso.org (à vérifier).'],
  ['Soro Yiriwaso', 'Mali', 'Microfinance rurale', 'Bamako / Sikasso', 'LinkedIn / Kiva', 'Agents de crédit sur groupes de femmes villageois (prêt de campagne).'],
  ['RCPB', 'Burkina Faso', 'Microfinance (caisses populaires)', 'Ouagadougou', 'LinkedIn', 'Plus grand réseau SFD du pays, nombreux agents et caisses. rcpb.bf (à vérifier).'],
  ['ALIDé', 'Bénin', 'Microfinance', 'Cotonou', 'LinkedIn / SIDI', 'Agents de crédit de proximité (quartiers, Sémé-Podji, Allada).'],
  ['PADME', 'Bénin', 'Microfinance', 'Cotonou', 'LinkedIn', 'Appui micro-entreprises, chargés de prêt terrain.'],
  ['FUCEC-Togo', 'Togo', 'Microfinance coopérative', 'Lomé', 'LinkedIn', 'Plus grand réseau mutualiste togolais, agents et caisses.'],
  ['Crédit Rural de Guinée', 'Guinée', 'Microfinance rurale', 'Conakry', 'LinkedIn', 'Réseau d’agences rurales, agents de crédit en zones reculées.'],
  ['Groupe NSIA (régional)', 'Régional', 'Assurance', 'Abidjan (siège)', 'LinkedIn / FANAF', '13 filiales assurance, réseaux d’agents à harmoniser. groupensia.com (à vérifier).'],
  ['Groupe Sunu', 'Régional', 'Assurance / micro-assurance', 'Dakar / Abidjan', 'LinkedIn / FANAF', '37 sociétés sur 17 pays, micro-assurance via microfinance. sunu-group.com (à vérifier).'],
  ['Gozem', 'Togo / Bénin', 'Livraison / VTC multi-pays', 'Lomé / Cotonou', 'LinkedIn', 'Coursiers moto/tricycle, expansion régionale (dont Abidjan annoncé). gozem.co (à vérifier).'],
  ['Orange Money Sénégal', 'Sénégal', 'Télécoms / mobile money', 'Dakar', 'LinkedIn', '~8 M abonnés, large réseau d’agents et animateurs. orange.sn (à vérifier).'],
  ['Laly Express', 'Bénin', 'Livraison express', 'Cotonou', 'LinkedIn', 'Coursiers express à géolocaliser et tracer.'],
];

export class ProspectsSeed1765500000001 implements MigrationInterface {
  name = 'ProspectsSeed1765500000001';

  public async up(q: QueryRunner): Promise<void> {
    for (const [entreprise, pays, secteur, ville, canal, notes] of PROSPECTS) {
      await q.query(
        `INSERT INTO prospects (entreprise, pays, secteur, ville, canal, notes) VALUES ($1, $2, $3, $4, $5, $6)`,
        [entreprise, pays, secteur, ville, canal, notes],
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [entreprise] of PROSPECTS) {
      await q.query(`DELETE FROM prospects WHERE entreprise = $1`, [entreprise]);
    }
  }
}
