import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { WorkDay } from './work-day.entity';

@Entity('day_pauses')
export class DayPause {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'day_id', type: 'uuid' })
  dayId: string;

  @ManyToOne(() => WorkDay, (day) => day.pauses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'day_id' })
  day?: WorkDay;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;
}
