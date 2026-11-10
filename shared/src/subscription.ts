/**
 * Formules d'abonnement : le catalogue (prix, quotas, fonctionnalités) est réglé par l'éditeur
 * dans sa console. Ces trois codes sont ceux de l'installation ; l'éditeur peut en créer d'autres.
 */
export const PlanCode = {
  Base: 'base',
  Advanced: 'advanced',
  Enterprise: 'enterprise',
} as const;
/** Code d'une formule : minuscules, chiffres, tirets (ex. « entreprise-plus »). */
export type PlanCode = string;
export const PLAN_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,29}$/;

export const SubscriptionStatus = {
  /** Essai gratuit : toutes les fonctionnalités */
  Trialing: 'trialing',
  Active: 'active',
  /** Facture échue non payée : avertissement, tout fonctionne encore */
  PastDue: 'past_due',
  /** Accès coupé, sauf l'abonnement et les factures */
  Suspended: 'suspended',
  Cancelled: 'cancelled',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

/** Validation d'une structure par l'éditeur avant son activation. */
export const TenantApprovalStatus = {
  /** Inscrite, en attente de validation par l'éditeur (accès bloqué) */
  Pending: 'pending',
  Approved: 'approved',
  /** Refusée par l'éditeur (accès bloqué) */
  Rejected: 'rejected',
} as const;
export type TenantApprovalStatus =
  (typeof TenantApprovalStatus)[keyof typeof TenantApprovalStatus];
export const TENANT_APPROVAL_STATUS_LABELS: Record<TenantApprovalStatus, string> = {
  pending: 'En attente',
  approved: 'Validée',
  rejected: 'Refusée',
};

export const BillingCycle = {
  Monthly: 'monthly',
  /** Engagement de 12 mois, remise sur chaque facture mensuelle */
  Annual: 'annual',
} as const;
export type BillingCycle = (typeof BillingCycle)[keyof typeof BillingCycle];

export const InvoiceStatus = {
  Pending: 'pending',
  Paid: 'paid',
  Void: 'void',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

/**
 * Lignes d'une facture : le forfait (au prorata après l'essai), les agents en plus, la remise
 * annuelle (sur ces deux lignes seulement), puis ce qui dépend du mois : camions actifs, lots de
 * photos IA au-delà du quota, frais de mise en place.
 */
export const InvoiceLineKind = {
  Plan: 'plan',
  ExtraAgents: 'extra_agents',
  Discount: 'discount',
  Vans: 'vans',
  PhotoAi: 'photo_ai',
  OneTime: 'one_time',
} as const;
export type InvoiceLineKind = (typeof InvoiceLineKind)[keyof typeof InvoiceLineKind];

export interface InvoiceLine {
  kind: InvoiceLineKind;
  label: string;
  quantity: number;
  unitPrice: number;
  /** Négatif pour la remise */
  amount: number;
}

/** Photos IA facturées par lots de cette taille au-delà du quota du mois. */
export const PHOTO_AI_LOT_SIZE = 100;

/** Demande de mise en place faite par une structure, décidée par l'éditeur. */
export const OnboardingRequestStatus = {
  Pending: 'pending',
  /** Acceptée : frais ajoutés à la prochaine facture */
  Accepted: 'accepted',
  Rejected: 'rejected',
  /** Retirée par la structure avant la décision */
  Cancelled: 'cancelled',
} as const;
export type OnboardingRequestStatus =
  (typeof OnboardingRequestStatus)[keyof typeof OnboardingRequestStatus];

export const ONBOARDING_REQUEST_STATUS_LABELS: Record<OnboardingRequestStatus, string> = {
  pending: 'En attente',
  accepted: 'Acceptée',
  rejected: 'Refusée',
  cancelled: 'Annulée',
};

/**
 * Forfait de mise en place (formation, import, configuration). Obligatoire : appliqué
 * automatiquement à l'activation d'une structure par l'éditeur. L'éditeur peut lui donner une
 * réduction standard en pourcentage (modifiable au cas par cas à la validation).
 */
export interface OnboardingPackage {
  code: string;
  name: string;
  description: string;
  price: number;
  /** Réduction standard de l'éditeur sur ce forfait, en pourcentage (0–100 ; 100 = offert). */
  discountPercent?: number;
}

/** Prix net d'une mise en place après réduction (arrondi), borné à 0–100 %. */
export function onboardingNetPrice(price: number, discountPercent = 0): number {
  const d = Math.min(100, Math.max(0, discountPercent));
  return Math.round(price * (1 - d / 100));
}

/**
 * Fonctionnalités soumises à formule. Le suivi en temps réel, les zones, les journées,
 * l'historique et l'app mobile sont inclus dans toutes les formules.
 */
export const Feature = {
  Groups: 'groups',
  ManualApproval: 'manual_approval',
  Missions: 'missions',
  Branding: 'branding',
  Exports: 'exports',
  Stats: 'stats',
  TeamLeads: 'team_leads',
  Audit: 'audit',
  /** Calcul automatique de la rémunération des agents et des chefs d'équipe */
  Payroll: 'payroll',
  /** Notifications sur les téléphones, même app fermée (Firebase Cloud Messaging) */
  PushNotifications: 'push_notifications',
  /** Répertoire des points de vente : identification sur le terrain, statuts, import et export */
  PointsOfSale: 'points_of_sale',
  /** Catalogue de produits et relevés par produit (stocks, prix, ventes, pertes, concurrence) ; demande les points de vente */
  ProductAudits: 'product_audits',
  /** Prise de commande terrain : types de client, prix, commandes et leur suivi ; demande les points de vente */
  Orders: 'orders',
  /** Vente en camionnette : stock des dépôts et camions, vente directe, reçus, caisse ; demande la prise de commande */
  VanSales: 'van_sales',
  /** Analyse des photos de rayon par IA (présence, faces, prix) ; quota mensuel par formule ; demande les relevés produits */
  PhotoAi: 'photo_ai',
} as const;
export type Feature = (typeof Feature)[keyof typeof Feature];

/**
 * Fonctionnalités qui en demandent d'autres : une formule qui inclut la clé doit inclure ses
 * prérequis (vérifié par l'API, appliqué automatiquement dans la console éditeur).
 */
export const FEATURE_REQUIRES: Partial<Record<Feature, Feature[]>> = {
  [Feature.ProductAudits]: [Feature.PointsOfSale],
  [Feature.Orders]: [Feature.PointsOfSale],
  [Feature.VanSales]: [Feature.Orders],
  [Feature.PhotoAi]: [Feature.ProductAudits],
};

/** Une fonctionnalité et tous ses prérequis, directs et indirects. */
export function withRequirements(feature: Feature): Feature[] {
  const all = new Set<Feature>([feature]);
  const pending = [feature];
  while (pending.length) {
    for (const req of FEATURE_REQUIRES[pending.pop()!] ?? []) {
      if (!all.has(req)) {
        all.add(req);
        pending.push(req);
      }
    }
  }
  return [...all];
}

/** Fonctionnalités qui dépendent (directement ou non) de celle-ci. */
export function dependentsOf(feature: Feature): Feature[] {
  return (Object.keys(FEATURE_REQUIRES) as Feature[]).filter(
    (f) => f !== feature && withRequirements(f).includes(feature),
  );
}

/** Premier prérequis manquant d'une liste de fonctionnalités, ou null si elle est complète. */
export function missingRequirement(features: Feature[]): { feature: Feature; requires: Feature } | null {
  for (const feature of features) {
    for (const requires of FEATURE_REQUIRES[feature] ?? []) {
      if (!features.includes(requires)) return { feature, requires };
    }
  }
  return null;
}

/**
 * Fonctionnalités des formules installées par défaut (migration et démo). Le catalogue en
 * vigueur est en base : l'éditeur le modifie depuis sa console.
 */
export const DEFAULT_PLAN_FEATURES: Record<string, Feature[]> = {
  base: [],
  advanced: [
    Feature.Groups,
    Feature.ManualApproval,
    Feature.Missions,
    Feature.Branding,
    Feature.Exports,
    Feature.PushNotifications,
  ],
  enterprise: Object.values(Feature),
};
