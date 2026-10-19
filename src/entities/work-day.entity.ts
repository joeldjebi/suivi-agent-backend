import type { DayEndReason, DayStatus } from '@suivi/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DayPause } from './day-pause.entity';

/** App mobile (iPhone, Android) ou version web dans le navigateur. */
export type DayClient = 'web' | 'ios' | 'android';

/** Support annoncé par l'app : en-tête X-App-Client (web) ou X-App-Platform (mobile). */
export function dayClient(header: string | undefined): DayClient | null {
  const value = header?.toLowerCase();
  return value === 'web' || value === 'ios' || value === 'android'
    ? value
    : null;
}

@Entity('work_days')
export class WorkDay {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @Column({ name: 'zone_id', type: 'uuid', nullable: true })
  zoneId: string | null;

  @Column({ type: 'text' })
  status: DayStatus;

  @Column({ name: 'work_date', type: 'date' })
  workDate: string;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ name: 'end_reason', type: 'text', nullable: true })
  endReason: DayEndReason | null;

  /** Support utilisé pour démarrer (ou reprendre) la journée */
  @Column({ type: 'text', nullable: true })
  client: DayClient | null;

  @OneToMany(() => DayPause, (pause) => pause.day)
  pauses?: DayPause[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
