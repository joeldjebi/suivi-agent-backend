import type { DayEndReason, DayStatus } from '@suivi/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DayPause } from './day-pause.entity';

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

  @OneToMany(() => DayPause, (pause) => pause.day)
  pauses?: DayPause[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
