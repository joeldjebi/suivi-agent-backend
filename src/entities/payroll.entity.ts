import type {
  AdjustmentStatus,
  PayGridComponents,
  PayGridTargets,
  PayPeriod,
  PayRunStatus,
} from '@suivi/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('pay_settings')
export class PaySettings {
  @PrimaryColumn({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ type: 'text' })
  period: PayPeriod;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** Grille de rémunération et à qui elle s'applique. */
@Entity('pay_grids')
export class PayGrid {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'jsonb' })
  components: PayGridComponents;

  @Column({ type: 'jsonb' })
  targets: PayGridTargets;

  @Column({ name: 'is_active' })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** Paie d'une période : brouillon calculé → validée → payée. */
@Entity('pay_runs')
export class PayRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ type: 'text' })
  period: PayPeriod;

  @Column({ name: 'period_start', type: 'date' })
  periodStart: string;

  @Column({ name: 'period_end', type: 'date' })
  periodEnd: string;

  @Column({ type: 'text' })
  status: PayRunStatus;

  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt: Date;

  @Column({ name: 'validated_at', type: 'timestamptz', nullable: true })
  validatedAt: Date | null;

  @Column({ name: 'validated_by_id', type: 'uuid', nullable: true })
  validatedById: string | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

/** Une ligne de paie détaillée, élément par élément. */
export interface PayItem {
  code: string;
  label: string;
  /** Nombre (journées, formulaires…), null pour un montant forfaitaire */
  quantity: number | null;
  unitAmount: number | null;
  amount: number;
}

@Entity('pay_lines')
export class PayLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'run_id', type: 'uuid' })
  runId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'grid_id', type: 'uuid', nullable: true })
  gridId: string | null;

  @Column({ name: 'grid_name', type: 'text', nullable: true })
  gridName: string | null;

  @Column({ type: 'jsonb' })
  items: PayItem[];

  @Column({ type: 'integer' })
  gross: number;

  /** Somme des ajustements approuvés */
  @Column({ type: 'integer' })
  adjustments: number;

  @Column({ type: 'integer' })
  total: number;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @Column({ name: 'payment_reference', type: 'text', nullable: true })
  paymentReference: string | null;
}

@Entity('pay_adjustments')
export class PayAdjustment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'run_id', type: 'uuid' })
  runId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** Positif (prime) ou négatif (retenue) */
  @Column({ type: 'integer' })
  amount: number;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'text' })
  status: AdjustmentStatus;

  @Column({ name: 'proposed_by_id', type: 'uuid', nullable: true })
  proposedById: string | null;

  @Column({ name: 'decided_by_id', type: 'uuid', nullable: true })
  decidedById: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
