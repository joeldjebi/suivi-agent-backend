import { FieldType, type MissionField } from '@suivi/shared';

/** Polygone GeoJSON. */
export interface Area {
  type: 'Polygon';
  coordinates: number[][][];
}

/** Rectangle [ouest, sud, est, nord]. */
const box = (w: number, s: number, e: number, n: number): Area => ({
  type: 'Polygon',
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});

/** Cercle approché (24 côtés) autour d'un point, rayon en mètres. */
export function circle(lat: number, lng: number, radiusM: number): Area {
  const points: number[][] = [];
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * 2 * Math.PI;
    points.push([
      Math.round((lng + dLng * Math.cos(a)) * 1e6) / 1e6,
      Math.round((lat + dLat * Math.sin(a)) * 1e6) / 1e6,
    ]);
  }
  points.push(points[0]);
  return { type: 'Polygon', coordinates: [points] };
}

export interface CatalogArea {
  /** « ville:commune » */
  key: string;
  name: string;
  area: Area;
}

export interface CatalogCity {
  key: string;
  name: string;
  /** Centre de la carte */
  center: { lat: number; lng: number };
  areas: CatalogArea[];
}

/**
 * Communes et villes prêtes à l'emploi : contours simplifiés (rectangles qui se touchent
 * sans se chevaucher), ajustables ensuite sur la carte.
 */
export const CITIES: CatalogCity[] = [
  {
    key: 'abidjan',
    name: 'Abidjan',
    center: { lat: 5.345, lng: -4.02 },
    areas: [
      ['abobo', 'Abobo', box(-4.04, 5.4, -4.0, 5.44)],
      ['adjame', 'Adjamé', box(-4.04, 5.345, -4.015, 5.37)],
      ['anyama', 'Anyama', box(-4.08, 5.47, -4.02, 5.52)],
      ['attecoube', 'Attécoubé', box(-4.058, 5.32, -4.035, 5.343)],
      ['bingerville', 'Bingerville', box(-3.92, 5.33, -3.86, 5.38)],
      ['cocody', 'Cocody', box(-4.0, 5.335, -3.95, 5.405)],
      ['koumassi', 'Koumassi', box(-3.958, 5.285, -3.93, 5.305)],
      ['marcory', 'Marcory', box(-3.988, 5.285, -3.962, 5.304)],
      ['plateau', 'Plateau', box(-4.03, 5.31, -4.01, 5.33)],
      ['port-bouet', 'Port-Bouët', box(-3.98, 5.23, -3.9, 5.28)],
      ['songon', 'Songon', box(-4.32, 5.29, -4.2, 5.36)],
      ['treichville', 'Treichville', box(-4.012, 5.29, -3.992, 5.305)],
      ['yopougon', 'Yopougon', box(-4.1, 5.32, -4.06, 5.36)],
    ].map(([key, name, area]) => ({
      key: `abidjan:${key as string}`,
      name: name as string,
      area: area as Area,
    })),
  },
  ...(
    [
      ['bouake', 'Bouaké', 7.6906, -5.0303],
      ['yamoussoukro', 'Yamoussoukro', 6.8276, -5.2893],
      ['san-pedro', 'San-Pédro', 4.7485, -6.6363],
      ['daloa', 'Daloa', 6.8774, -6.4502],
      ['korhogo', 'Korhogo', 9.458, -5.6296],
      ['man', 'Man', 7.4125, -7.5536],
      ['gagnoa', 'Gagnoa', 6.1319, -5.9506],
      ['abengourou', 'Abengourou', 6.7297, -3.4964],
    ] as const
  ).map(([key, name, lat, lng]) => ({
    key,
    name,
    center: { lat, lng },
    areas: [
      {
        key: `${key}:centre`,
        name: `${name} centre`,
        area: circle(lat, lng, 3000),
      },
    ],
  })),
];

export const AREA_BY_KEY = new Map(
  CITIES.flatMap((c) => c.areas.map((a) => [a.key, a] as const)),
);

const f = (
  key: string,
  label: string,
  type: MissionField['type'],
  required = false,
  options?: string[],
): MissionField => ({
  key,
  label,
  type,
  required,
  ...(options ? { options } : {}),
});

export interface Activity {
  key: string;
  label: string;
  description: string;
  /** Exemples de métiers concernés */
  examples: string;
  missionTypes: { name: string; description: string; fields: MissionField[] }[];
  /** Première mission créée : un objectif de formulaires sur la semaine */
  mission: { title: string; description: string; perAgent: number };
}

/** Modèles par métier : formulaires prêts à l'emploi, modifiables ensuite. */
export const ACTIVITIES: Activity[] = [
  {
    key: 'sales',
    label: 'Vente et prospection',
    description:
      'Visiter des commerces, présenter vos produits, prendre des commandes.',
    examples: 'Commerciaux terrain, distributeurs, grossistes',
    missionTypes: [
      {
        name: 'Visite commerciale',
        description: 'Une visite = un formulaire.',
        fields: [
          f('commerce', 'Nom du commerce', FieldType.Text, true),
          f('contact', 'Nom du gérant', FieldType.Text),
          f('telephone', 'Téléphone du gérant', FieldType.Text),
          f('interesse', 'Client intéressé', FieldType.Boolean, true),
          f('commande', 'Montant commandé (FCFA)', FieldType.Number),
          f('vitrine', 'Photo du commerce', FieldType.Photo),
        ],
      },
    ],
    mission: {
      title: 'Visites commerciales de la semaine',
      description:
        'Visitez les commerces de votre zone et remplissez un formulaire par visite.',
      perAgent: 30,
    },
  },
  {
    key: 'collection',
    label: 'Recouvrement',
    description:
      'Passer chez les clients, encaisser, noter les promesses de paiement.',
    examples: 'Microfinance, crédit, services aux particuliers',
    missionTypes: [
      {
        name: 'Visite de recouvrement',
        description: 'Une visite client = un formulaire.',
        fields: [
          f('client', 'Nom du client', FieldType.Text, true),
          f('montant_du', 'Montant dû (FCFA)', FieldType.Number),
          f(
            'montant_encaisse',
            'Montant encaissé (FCFA)',
            FieldType.Number,
            true,
          ),
          f('paiement', 'Mode de paiement', FieldType.Select, true, [
            'Espèces',
            'Mobile Money',
            'Chèque',
            'Aucun',
          ]),
          f('promesse', 'Date promise de paiement', FieldType.Date),
          f('recu', 'Photo du reçu', FieldType.Photo),
        ],
      },
    ],
    mission: {
      title: 'Recouvrements de la semaine',
      description:
        'Passez chez les clients de votre zone et notez chaque visite.',
      perAgent: 25,
    },
  },
  {
    key: 'survey',
    label: 'Enquêtes et collecte',
    description:
      'Interroger des personnes et recueillir des informations sur le terrain.',
    examples: 'Études, recensements, ONG, sondages',
    missionTypes: [
      {
        name: 'Questionnaire',
        description: 'Une personne interrogée = un formulaire.',
        fields: [
          f('nom', 'Nom de la personne', FieldType.Text),
          f('age', 'Âge', FieldType.Number),
          f('quartier', 'Quartier', FieldType.Text, true),
          f('satisfaction', 'Niveau de satisfaction', FieldType.Select, true, [
            'Très satisfait',
            'Satisfait',
            'Peu satisfait',
            'Pas satisfait',
          ]),
          f('commentaire', 'Commentaire', FieldType.Text),
        ],
      },
    ],
    mission: {
      title: 'Questionnaires de la semaine',
      description: 'Interrogez les personnes de votre zone.',
      perAgent: 40,
    },
  },
  {
    key: 'insurance',
    label: 'Assurance et banque',
    description:
      'Présenter des offres, prendre des rendez-vous, ouvrir des comptes.',
    examples: 'Agents d’assurance, conseillers, Mobile Money',
    missionTypes: [
      {
        name: 'Prospection client',
        description: 'Un prospect rencontré = un formulaire.',
        fields: [
          f('nom', 'Nom du prospect', FieldType.Text, true),
          f('telephone', 'Téléphone', FieldType.Text),
          f('activite', 'Activité du prospect', FieldType.Text),
          f('produit', 'Produit présenté', FieldType.Select, true, [
            'Épargne',
            'Crédit',
            'Assurance',
            'Compte Mobile Money',
          ]),
          f('interesse', 'Prospect intéressé', FieldType.Boolean, true),
          f('rendez_vous', 'Date de rendez-vous', FieldType.Date),
        ],
      },
    ],
    mission: {
      title: 'Prospects de la semaine',
      description: 'Rencontrez des prospects dans votre zone.',
      perAgent: 20,
    },
  },
  {
    key: 'merchandising',
    label: 'Merchandising et contrôle',
    description: 'Vérifier la présence et le prix de vos produits en boutique.',
    examples: 'Marques, distributeurs, contrôle qualité',
    missionTypes: [
      {
        name: 'Contrôle en boutique',
        description: 'Une boutique contrôlée = un formulaire.',
        fields: [
          f('boutique', 'Nom de la boutique', FieldType.Text, true),
          f('present', 'Produit présent en rayon', FieldType.Boolean, true),
          f('prix', 'Prix constaté (FCFA)', FieldType.Number),
          f('rupture', 'Rupture de stock', FieldType.Boolean),
          f('rayon', 'Photo du rayon', FieldType.Photo),
        ],
      },
    ],
    mission: {
      title: 'Contrôles de la semaine',
      description: 'Contrôlez les boutiques de votre zone.',
      perAgent: 30,
    },
  },
  {
    key: 'other',
    label: 'Autre activité',
    description: 'Un formulaire simple : lieu visité, compte rendu et photo.',
    examples: 'Livraison, maintenance, inspection…',
    missionTypes: [
      {
        name: 'Visite terrain',
        description: 'Une visite = un formulaire.',
        fields: [
          f('lieu', 'Lieu visité', FieldType.Text, true),
          f('compte_rendu', 'Compte rendu', FieldType.Text, true),
          f('photo', 'Photo', FieldType.Photo),
        ],
      },
    ],
    mission: {
      title: 'Visites terrain de la semaine',
      description:
        'Faites vos visites et remplissez un formulaire pour chacune.',
      perAgent: 20,
    },
  },
];
