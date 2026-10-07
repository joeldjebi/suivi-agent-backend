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
} as const;
export type Feature = (typeof Feature)[keyof typeof Feature];

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
