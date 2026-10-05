import type { ZoneExitEndReason } from '@suivi/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Passage d'un agent hors de sa zone pendant sa journée. */
@Entity('zone_exits')
export class ZoneExit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'day_id', type: 'uuid' })
  dayId: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @Column({ name: 'zone_id', type: 'uuid' })
  zoneId: string;

  @Column({ name: 'exited_at', type: 'timestamptz' })
  exitedAt: Date;

  /** Retour dans la zone, fin de journée ou changement de zone ; vide : toujours dehors. */
  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ name: 'end_reason', type: 'text', nullable: true })
  endReason: ZoneExitEndReason | null;

  /** Plus grande distance à la zone pendant la sortie, en mètres. */
  @Column({ name: 'max_distance_m', type: 'int' })
  maxDistanceM: number;

  /** Chef prévenu (sortie qui a duré au-delà du délai d'alerte). */
  @Column({ name: 'alerted_at', type: 'timestamptz', nullable: true })
  alertedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
