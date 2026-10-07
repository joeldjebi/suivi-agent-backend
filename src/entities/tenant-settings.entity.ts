import type {
  ApprovalMode,
  ExpirationAction,
  ZoneAccessWithoutGroups,
} from '@suivi/shared';
import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export interface MixedCriteria {
  /** RG-23 : la zone est marquée « sensible ». */
  sensitiveZone: boolean;
  /** RG-23 : la zone atteint ce pourcentage de remplissage (null = critère inactif). */
  fillThresholdPercent: number | null;
  /** RG-23 : il s'agit d'un changement de zone. */
  zoneChange: boolean;
  /** RG-23 : l'agent est en période d'essai. */
  probationAgent: boolean;
}

@Entity('tenant_settings')
export class TenantSettings {
  @PrimaryColumn({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'use_groups' })
  useGroups: boolean;

  @Column({ name: 'zone_access_without_groups', type: 'text' })
  zoneAccessWithoutGroups: ZoneAccessWithoutGroups;

  @Column({ name: 'zone_required' })
  zoneRequired: boolean;

  @Column({ name: 'approval_mode', type: 'text' })
  approvalMode: ApprovalMode;

  @Column({ name: 'mixed_criteria', type: 'jsonb' })
  mixedCriteria: MixedCriteria;

  @Column({ name: 'request_expiration_minutes' })
  requestExpirationMinutes: number;

  @Column({ name: 'expiration_action_manual', type: 'text' })
  expirationActionManual: ExpirationAction;

  @Column({ name: 'expiration_action_mixed', type: 'text' })
  expirationActionMixed: ExpirationAction;

  @Column({ name: 'allow_zone_change_before_start' })
  allowZoneChangeBeforeStart: boolean;

  @Column({ name: 'start_while_pending' })
  startWhilePending: boolean;

  /** Format HH:mm, heure locale de la structure. */
  @Column({ name: 'daily_reset_time' })
  dailyResetTime: string;

  @Column()
  timezone: string;

  @Column({ name: 'track_during_pause' })
  trackDuringPause: boolean;

  @Column({ name: 'auto_end_day_at_reset' })
  autoEndDayAtReset: boolean;

  @Column({ name: 'signal_lost_minutes' })
  signalLostMinutes: number;

  /** Marge autour de la zone avant de compter une sortie (imprécision du GPS), en mètres */
  @Column({ name: 'zone_exit_tolerance_meters' })
  zoneExitToleranceMeters: number;

  /** Durée hors zone avant de prévenir le chef, en minutes */
  @Column({ name: 'zone_exit_alert_minutes' })
  zoneExitAlertMinutes: number;

  /** Heure de début attendue (HH:MM) ; vide : pas d'alerte « journée pas démarrée » */
  @Column({ name: 'alert_start_time', type: 'text', nullable: true })
  alertStartTime: string | null;

  /** Marge après l'heure de début avant l'alerte, en minutes */
  @Column({ name: 'alert_late_minutes' })
  alertLateMinutes: number;

  /** Jours travaillés (1 = lundi … 7 = dimanche) */
  @Column({ name: 'alert_workdays', type: 'int', array: true })
  alertWorkdays: number[];

  /** Immobile depuis ce délai, en minutes ; vide : pas d'alerte */
  @Column({ name: 'alert_immobile_minutes', type: 'int', nullable: true })
  alertImmobileMinutes: number | null;

  /** Rayon sous lequel l'agent est considéré immobile, en mètres */
  @Column({ name: 'alert_immobile_radius_m' })
  alertImmobileRadiusM: number;

  /** Seuil de batterie faible, en % ; vide : pas d'alerte */
  @Column({ name: 'alert_battery_percent', type: 'int', nullable: true })
  alertBatteryPercent: number | null;

  @Column({ name: 'alert_signal_lost' })
  alertSignalLost: boolean;

  @Column({ name: 'alert_mocked' })
  alertMocked: boolean;

  /** Formulaires acceptés seulement pendant une journée dans une zone de la mission */
  @Column({ name: 'submission_requires_day' })
  submissionRequiresDay: boolean;

  /** Heure d'envoi du bilan de fin de journée aux responsables (HH:MM) ; vide : pas d'envoi */
  @Column({ name: 'daily_report_time', type: 'text', nullable: true })
  dailyReportTime: string | null;

  @Column({ name: 'position_retention_days' })
  positionRetentionDays: number;

  @Column({
    name: 'last_reset_date',
    type: 'date',
    nullable: true,
    select: false,
  })
  lastResetDate: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
