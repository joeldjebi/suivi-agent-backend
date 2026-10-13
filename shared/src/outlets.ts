/**
 * Points de vente : répertoire construit sur le terrain par les agents (ou importé), avec
 * un statut commercial qui évolue au fil des visites.
 */
export const OutletStatus = {
  New: 'new',
  Prospect: 'prospect',
  Active: 'active',
  Inactive: 'inactive',
  Closed: 'closed',
} as const;
export type OutletStatus = (typeof OutletStatus)[keyof typeof OutletStatus];

export const OUTLET_STATUS_LABELS: Record<OutletStatus, string> = {
  new: 'Nouveau',
  prospect: 'Prospect',
  active: 'Client actif',
  inactive: 'Inactif',
  closed: 'Fermé',
};

/** Types de commerce proposés ; la structure peut en saisir d'autres. */
export const OUTLET_CATEGORIES = [
  'Boutique',
  'Supérette',
  'Supermarché',
  'Kiosque',
  'Pharmacie',
  'Maquis / Bar',
  'Restaurant',
  'Grossiste',
  'Demi-grossiste',
  'Station-service',
  'Étal de marché',
  'Autre',
] as const;
