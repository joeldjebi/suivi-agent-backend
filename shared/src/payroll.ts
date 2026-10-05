/** Rémunération : calcul automatique par période, validation, export (aucun paiement en ligne). */
export const PayPeriod = {
  Weekly: 'weekly',
  /** Du 1er au 15, puis du 16 à la fin du mois */
  Biweekly: 'biweekly',
  Monthly: 'monthly',
} as const;
export type PayPeriod = (typeof PayPeriod)[keyof typeof PayPeriod];

export const PayRunStatus = {
  /** Calculée automatiquement, ajustable */
  Draft: 'draft',
  /** Verrouillée par l'administrateur */
  Validated: 'validated',
  Paid: 'paid',
} as const;
export type PayRunStatus = (typeof PayRunStatus)[keyof typeof PayRunStatus];

export const AdjustmentStatus = {
  /** Proposé par un chef d'équipe, en attente de l'administrateur */
  Proposed: 'proposed',
  Approved: 'approved',
  Rejected: 'rejected',
} as const;
export type AdjustmentStatus = (typeof AdjustmentStatus)[keyof typeof AdjustmentStatus];

/** Éléments d'une grille de rémunération (tous facultatifs). */
export interface PayGridComponents {
  /** Montant fixe par période */
  fixed?: number | null;
  /** Par journée validée */
  perDay?: {
    amount: number;
    /** Heures minimum pour que la journée compte */
    minHours?: number | null;
    /** Journée passée à plus de 80 % dans sa zone */
    requireInZone?: boolean;
  } | null;
  /** Par formulaire accepté ; montant propre à un type de mission si précisé */
  perForm?: { amount: number; byType?: Record<string, number> } | null;
  /** Pourcentage des montants saisis (missions dont les montants s'additionnent) */
  commission?: { percent: number } | null;
  /** Primes d'objectif : mission atteinte à X % ou plus (palier le plus haut retenu) */
  objectiveBonus?: ObjectiveTier[] | null;
  /** Chef d'équipe : selon l'activité de son équipe */
  teamBonus?: { perTeamDay?: number | null; perTeamForm?: number | null } | null;
  /** Retenues */
  deductions?: {
    perAutoClosedDay?: number | null;
    perRejectedForm?: number | null;
    perMockedDay?: number | null;
  } | null;
  /** Plafond du total par période */
  cap?: number | null;
}

/** À qui s'applique une grille : l'agent l'emporte sur le groupe, le groupe sur le rôle. */
export interface PayGridTargets {
  roles?: ('agent' | 'team_lead')[];
  groupIds?: string[];
  userIds?: string[];
}

/** Palier de prime d'objectif : mission atteinte à X % ou plus. */
export interface ObjectiveTier {
  thresholdPercent: number;
  amount: number;
}

/**
 * Conditions de rémunération d'un type de mission ou d'une mission (administrateur seulement).
 * Ordre : la mission, sinon son type, sinon la grille de l'agent (par défaut). Elles REMPLACENT
 * la grille pour les formulaires et l'objectif ; le fixe, les journées, les retenues de journée
 * et le plafond restent ceux de la grille.
 */
export interface MissionPay {
  /** Par formulaire accepté */
  perForm?: number | null;
  /** Pourcentage des montants saisis (mission « somme d'un champ ») */
  commissionPercent?: number | null;
  /** Primes d'objectif de la mission */
  objectiveBonus?: ObjectiveTier[] | null;
  /** Chef d'équipe : par formulaire accepté de son équipe sur cette mission */
  leadPerTeamForm?: number | null;
}

/** Ce que rapporte une mission à l'agent connecté. */
export interface MissionEarnings {
  /** « mission » : conditions de la mission ; « type » : celles de son type ; « grid » : grille de l'agent */
  source: 'mission' | 'type' | 'grid';
  perForm: number | null;
  commissionPercent: number | null;
  objectiveBonus: ObjectiveTier[];
}
