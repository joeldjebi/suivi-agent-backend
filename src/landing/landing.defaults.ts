import type { LandingContent } from '@suivi/shared';

/** Contenu du site à l'installation ; l'éditeur le modifie depuis sa console. */
export const DEFAULT_LANDING: LandingContent = {
  version: 1,
  brand: {
    name: 'Suivi Agent',
    tagline: 'Vos équipes terrain, en temps réel.',
  },
  seo: {
    title: 'Suivi Agent · Pilotez vos équipes terrain en temps réel',
    description:
      'Positions en direct, zones maîtrisées, missions mesurables et rémunération calculée automatiquement. L’application des structures qui travaillent sur le terrain.',
  },
  hero: {
    eyebrow: 'Nouveau · Rémunération automatique',
    title: 'Le terrain,\nenfin visible.',
    subtitle:
      'Suivez vos agents en temps réel, organisez vos zones et mesurez chaque mission. Depuis un téléphone, même hors connexion.',
    primary: { label: 'Essayer gratuitement', action: 'signup' },
    secondary: { label: 'Demander une démo', action: 'demo' },
    visual: 'map',
    imageId: null,
  },
  sections: [
    {
      id: 'promesse',
      type: 'statement',
      enabled: true,
      text: 'Vos équipes travaillent dehors, loin de vos yeux.',
      emphasis: 'Désormais, vous voyez tout. En temps réel.',
    },
    {
      id: 'fonctionnalites',
      type: 'bento',
      enabled: true,
      navLabel: 'Fonctionnalités',
      eyebrow: 'Tout en un',
      title: 'Tout ce dont\nle terrain a besoin.',
      tiles: [
        {
          title: 'Carte en temps réel',
          text: 'Chaque agent en journée, sa zone, son parcours. Les alertes s’affichent d’elles-mêmes.',
          visual: 'map',
          size: 'large',
        },
        {
          title: 'Même sans réseau',
          text: 'Positions et formulaires partent dès que le réseau revient.',
          visual: 'offline',
          size: 'tall',
        },
        {
          title: 'Alertes utiles',
          text: 'Hors zone, signal perdu, position simulée.',
          visual: 'alerts',
          size: 'small',
        },
        {
          title: 'Missions mesurées',
          text: 'Objectifs et progression en direct.',
          visual: 'missions',
          size: 'small',
        },
        {
          title: 'La paie se calcule seule',
          text: 'Fixe, journées, formulaires, primes : à partir de l’activité réelle.',
          visual: 'payroll',
          size: 'wide',
        },
        {
          title: 'Statistiques',
          text: 'Heures, présence, performance.',
          visual: 'chart',
          size: 'wide',
        },
        {
          title: 'Sur le terrain et au bureau',
          text: 'Une app mobile pour les agents, une plateforme web pour piloter.',
          visual: 'devices',
          size: 'wide',
        },
        {
          title: 'Données isolées',
          text: 'Chaque structure, son espace. Accès journalisés.',
          visual: 'security',
          size: 'wide',
        },
      ],
    },
    {
      id: 'parcours',
      type: 'story',
      enabled: true,
      eyebrow: 'Une journée d’agent',
      title: 'Simple comme\nun bouton.',
      steps: [
        {
          title: 'Il choisit sa zone',
          text: 'Les places sont limitées par zone : plus de doublons, plus de zones oubliées.',
        },
        {
          title: 'Il démarre sa journée',
          text: 'Un geste, et le suivi commence. Pause et fin de journée tout aussi simples.',
        },
        {
          title: 'Il remplit ses formulaires',
          text: 'Visites, ventes, audits : les formulaires de mission fonctionnent même sans réseau.',
        },
        {
          title: 'Il voit ses gains',
          text: 'L’estimation de sa rémunération se met à jour en direct, à partir de son activité réelle.',
        },
      ],
    },
    {
      id: 'carte',
      type: 'feature',
      enabled: true,
      eyebrow: 'Carte en temps réel',
      title: 'Chaque agent,\nà sa place.',
      text: 'Une carte vivante de toute votre équipe : qui est en journée, dans quelle zone, depuis quand. Les alertes apparaissent d’elles-mêmes : hors zone, signal perdu, position simulée.',
      bullets: [
        'Positions toutes les 30 secondes pendant la journée de travail',
        'Itinéraire de la journée rejoué en un clic',
        'Suivi limité à la journée : la vie privée des agents est respectée',
      ],
      visual: 'map',
      imageId: null,
      layout: 'right',
      dark: true,
    },
    {
      id: 'remuneration',
      type: 'feature',
      enabled: true,
      eyebrow: 'Rémunération',
      title: 'La paie,\ncalculée pour vous.',
      text: 'Fixe, journées validées, formulaires, primes d’objectif, retenues : vos règles s’appliquent automatiquement à l’activité réelle. Vous validez, vous payez par Mobile Money.',
      bullets: [
        'Grilles par rôle, par groupe ou par personne',
        'Fichier de paiement prêt pour Mobile Money',
        'Chaque agent voit le détail de ses gains',
      ],
      visual: 'payroll',
      imageId: null,
      layout: 'right',
    },
    {
      id: 'profils',
      type: 'audiences',
      enabled: true,
      navLabel: 'Pour qui',
      eyebrow: 'Pour toute l’équipe',
      title: 'Chacun son espace.\nUne seule plateforme.',
      items: [
        {
          title: 'Agents',
          text: 'Une app mobile claire : zone, journée, missions et gains. Pensée pour le terrain, rapide en 3G.',
          icon: 'smartphone',
        },
        {
          title: 'Chefs d’équipe',
          text: 'Leur équipe en direct, les demandes à valider, les formulaires à contrôler. Depuis le mobile ou le web.',
          icon: 'users',
        },
        {
          title: 'Administrateurs',
          text: 'Zones, groupes, statistiques, rémunération et facturation : toute la structure, au même endroit.',
          icon: 'layout-dashboard',
        },
      ],
    },
    {
      id: 'chiffres',
      type: 'stats',
      enabled: true,
      items: [
        { value: '30 s', label: 'entre deux positions d’un agent en journée' },
        { value: '100 %', label: 'des données isolées par structure' },
        { value: '0', label: 'saisie pour calculer la rémunération' },
        { value: '3G', label: 'suffit : l’app fonctionne hors connexion' },
      ],
    },
    {
      id: 'tarifs',
      type: 'pricing',
      enabled: true,
      navLabel: 'Tarifs',
      eyebrow: 'Tarifs',
      title: 'Un forfait clair.\nSans surprise.',
      subtitle:
        'Chaque formule inclut un nombre de chefs d’équipe et d’agents. Ajoutez des agents quand vous grandissez.',
    },
    {
      id: 'temoignages',
      type: 'testimonials',
      enabled: false,
      title: 'Ils pilotent leur terrain avec nous.',
      items: [
        {
          quote:
            'Nous savons enfin où sont nos équipes, et la paie de fin de mois prend une heure au lieu de trois jours.',
          author: 'Prénom Nom',
          role: 'Directeur commercial, votre client',
        },
      ],
    },
    {
      id: 'faq',
      type: 'faq',
      enabled: true,
      navLabel: 'Questions',
      title: 'Questions fréquentes',
      items: [
        {
          question: 'L’application fonctionne-t-elle sans réseau ?',
          answer:
            'Oui. Les positions et les formulaires sont gardés sur le téléphone et envoyés dès que le réseau revient.',
        },
        {
          question: 'Les agents sont-ils suivis en dehors du travail ?',
          answer:
            'Non. Le suivi ne fonctionne que pendant la journée de travail démarrée par l’agent, et s’arrête dès qu’il la termine.',
        },
        {
          question: 'Comment se passe le paiement de l’abonnement ?',
          answer:
            'Une facture mensuelle, payable par Mobile Money, virement ou espèces. Pas de carte bancaire nécessaire pour l’essai.',
        },
        {
          question: 'Nos données sont-elles protégées ?',
          answer:
            'Chaque structure a son espace isolé. Les accès sont journalisés et les comptes protégés par mot de passe.',
        },
      ],
    },
    {
      id: 'commencer',
      type: 'cta',
      enabled: true,
      title: 'Prêt à voir votre terrain ?',
      text: 'Créez votre espace en deux minutes. Essai gratuit, sans engagement.',
      primary: { label: 'Commencer l’essai gratuit', action: 'signup' },
      secondary: { label: 'Parler à un conseiller', action: 'demo' },
    },
    {
      id: 'missions',
      type: 'feature',
      enabled: false,
      eyebrow: 'Missions et objectifs',
      title: 'Des objectifs\nqui se mesurent.',
      text: 'Fixez des objectifs à une équipe ou à un agent, avec vos propres formulaires. La progression se calcule seule, au fil des formulaires acceptés.',
      bullets: [
        'Formulaires sur mesure : texte, nombres, choix, photos',
        'Validation ou rejet par le chef d’équipe',
        'Progression en direct et alertes d’échéance',
      ],
      visual: 'missions',
      imageId: null,
      layout: 'left',
    },
    {
      id: 'tableau-de-bord',
      type: 'feature',
      enabled: false,
      eyebrow: 'Statistiques',
      title: 'Décidez sur\ndes faits.',
      text: 'Heures travaillées, présence par zone, performance des équipes et des chefs : vos indicateurs se construisent seuls, jour après jour.',
      bullets: [
        'Tableaux de bord par période, groupe, zone ou agent',
        'Exports pour la comptabilité',
        'Journal d’accès complet',
      ],
      visual: 'dashboard',
      imageId: null,
      layout: 'left',
    },
  ],
  footer: {
    text: 'Suivi Agent, la plateforme de suivi des équipes terrain.',
    email: 'contact@suivi-agent.ci',
    phone: '+225 07 07 07 07 07',
    address: 'Abidjan, Côte d’Ivoire',
  },
};
