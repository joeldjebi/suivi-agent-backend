import type { SubmissionStatus } from '@suivi/shared';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('mission_submissions')
export class MissionSubmission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'mission_id', type: 'uuid' })
  missionId: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @Column({ name: 'day_id', type: 'uuid', nullable: true })
  dayId: string | null;

  /** Identifiant généré par le téléphone : rend la synchronisation hors ligne idempotente. */
  @Column({ name: 'client_id', type: 'uuid' })
  clientId: string;

  @Column({ type: 'jsonb' })
  data: Record<string, unknown>;

  @Column({ type: 'double precision', nullable: true })
  lat: number | null;

  @Column({ type: 'double precision', nullable: true })
  lng: number | null;

  @Column({ name: 'submitted_at', type: 'timestamptz' })
  submittedAt: Date;

  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;

  @Column({ type: 'text' })
  status: SubmissionStatus;

  @Column({ name: 'rejected_reason', type: 'text', nullable: true })
  rejectedReason: string | null;

  @Column({ name: 'rejected_by_id', type: 'uuid', nullable: true })
  rejectedById: string | null;

  @Column({ name: 'rejected_at', type: 'timestamptz', nullable: true })
  rejectedAt: Date | null;
}
