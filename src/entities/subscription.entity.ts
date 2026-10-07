import type {
  BillingCycle,
  Feature,
  InvoiceStatus,
  PlanCode,
  SubscriptionStatus,
} from '@suivi/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Formule du catalogue (commune à toutes les structures). */
@Entity('plans')
export class Plan {
  @PrimaryColumn({ type: 'text' })
  code: PlanCode;

  @Column()
  name: string;

  @Column()
  description: string;

  /** Forfait mensuel, dans la devise de la plateforme */
  @Column({ name: 'monthly_price', type: 'integer' })
  monthlyPrice: number;

  /** Comptes actifs inclus dans le forfait */
  @Column({ name: 'included_agents', type: 'integer' })
  includedAgents: number;

  @Column({ name: 'included_leads', type: 'integer' })
  includedLeads: number;

  /** Prix mensuel d'un agent au-delà du quota */
  @Column({ name: 'extra_agent_price', type: 'integer' })
  extraAgentPrice: number;

  @Column({ type: 'integer' })
  sort: number;

  @Column({ name: 'is_active' })
  isActive: boolean;

  /** Fonctionnalités (avantages) incluses, réglées par l'éditeur */
  @Column({ type: 'text', array: true })
  features: Feature[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** Réglages de facturation de la plateforme (une seule ligne). */
@Entity('platform_settings')
export class PlatformSettings {
  @PrimaryColumn({ type: 'integer' })
  id: number;

  @Column({ type: 'text' })
  currency: string;

  @Column({ name: 'trial_days', type: 'integer' })
  trialDays: number;

  @Column({ name: 'annual_discount_percent', type: 'integer' })
  annualDiscountPercent: number;

  @Column({ name: 'invoice_due_days', type: 'integer' })
  invoiceDueDays: number;

  @Column({ name: 'suspend_after_days', type: 'integer' })
  suspendAfterDays: number;

  /** Formule dont l'essai gratuit prend les quotas (toutes les fonctionnalités sont ouvertes) */
  @Column({ name: 'trial_plan_code', type: 'text' })
  trialPlanCode: PlanCode;

  /** Formule attribuée à une nouvelle structure (elle s'applique à la fin de l'essai) */
  @Column({ name: 'default_plan_code', type: 'text' })
  defaultPlanCode: PlanCode;

  /** App mobile : en dessous, mise à jour obligatoire (ex. 1.2.0) */
  @Column({ name: 'min_app_version', type: 'text', nullable: true })
  minAppVersion: string | null;

  /** Dernière version publiée : mise à jour proposée */
  @Column({ name: 'latest_app_version', type: 'text', nullable: true })
  latestAppVersion: string | null;

  @Column({ name: 'android_store_url', type: 'text', nullable: true })
  androidStoreUrl: string | null;

  @Column({ name: 'ios_store_url', type: 'text', nullable: true })
  iosStoreUrl: string | null;
}

@Entity('subscriptions')
export class Subscription {
  @PrimaryColumn({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'plan_code', type: 'text' })
  planCode: PlanCode;

  @Column({ name: 'billing_cycle', type: 'text' })
  billingCycle: BillingCycle;

  @Column({ type: 'text' })
  status: SubscriptionStatus;

  @Column({ name: 'trial_ends_at', type: 'timestamptz', nullable: true })
  trialEndsAt: Date | null;

  @Column({ name: 'commitment_ends_at', type: 'timestamptz', nullable: true })
  commitmentEndsAt: Date | null;

  /** Agents achetés en plus du quota de la formule */
  @Column({ name: 'extra_agents', type: 'integer' })
  extraAgents: number;

  @Column({ name: 'suspended_at', type: 'timestamptz', nullable: true })
  suspendedAt: Date | null;

  /** Conditions négociées par l'éditeur (null : celles de la formule) */
  @Column({ name: 'custom_monthly_price', type: 'integer', nullable: true })
  customMonthlyPrice: number | null;

  @Column({ name: 'custom_included_agents', type: 'integer', nullable: true })
  customIncludedAgents: number | null;

  @Column({ name: 'custom_included_leads', type: 'integer', nullable: true })
  customIncludedLeads: number | null;

  /** Suspension décidée par l'éditeur : la régularisation des factures ne la lève pas */
  @Column({ name: 'manual_suspension', type: 'boolean', default: false })
  manualSuspension: boolean;

  @Column({ name: 'suspension_reason', type: 'text', nullable: true })
  suspensionReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** Facture mensuelle : forfait + agents supplémentaires, remise annuelle déduite. */
@Entity('invoices')
export class Invoice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column()
  number: string;

  /** Premier jour du mois facturé (AAAA-MM-01) */
  @Column({ type: 'date' })
  month: string;

  @Column({ name: 'plan_code', type: 'text' })
  planCode: PlanCode;

  @Column({ name: 'billing_cycle', type: 'text' })
  billingCycle: BillingCycle;

  /** Agents actifs le jour de la facture (information) */
  @Column({ type: 'integer' })
  agents: number;

  @Column({ name: 'base_price', type: 'integer' })
  basePrice: number;

  @Column({ name: 'extra_agents', type: 'integer' })
  extraAgents: number;

  @Column({ name: 'extra_agent_price', type: 'integer' })
  extraAgentPrice: number;

  /** Part du mois facturée (fin d'essai en cours de mois) */
  @Column({ name: 'prorata_percent', type: 'integer' })
  prorataPercent: number;

  @Column({ name: 'discount_percent', type: 'integer' })
  discountPercent: number;

  @Column({ type: 'integer' })
  amount: number;

  @Column()
  currency: string;

  @Column({ type: 'text' })
  status: InvoiceStatus;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt: Date;

  @Column({ name: 'due_at', type: 'timestamptz' })
  dueAt: Date;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @Column({ name: 'payment_reference', type: 'text', nullable: true })
  paymentReference: string | null;

  /** Moyen de paiement : mobile_money, transfer, cash, other */
  @Column({ name: 'payment_method', type: 'text', nullable: true })
  paymentMethod: string | null;

  /** Compte de l'éditeur qui a enregistré le paiement ou l'annulation */
  @Column({ name: 'recorded_by', type: 'text', nullable: true })
  recordedBy: string | null;

  @Column({ name: 'void_reason', type: 'text', nullable: true })
  voidReason: string | null;
}
