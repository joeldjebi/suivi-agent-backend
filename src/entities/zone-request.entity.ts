import type { ZoneRequestStatus } from '@suivi/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Une demande de zone est aussi la place occupée dans la zone :
 * « pending » réserve la place (RG-17), « approved » l'occupe.
 */
@Entity('zone_requests')
export class ZoneRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @Column({ name: 'zone_id', type: 'uuid' })
  zoneId: string;

  @Column({ type: 'text' })
  status: ZoneRequestStatus;

  @Column({ name: 'is_change' })
  isChange: boolean;

  @Column({ name: 'requires_approval' })
  requiresApproval: boolean;

  @Column({ name: 'work_date', type: 'date' })
  workDate: string;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'reminder_sent_at', type: 'timestamptz', nullable: true })
  reminderSentAt: Date | null;

  @Column({ name: 'decided_by_id', type: 'uuid', nullable: true })
  decidedById: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ name: 'decision_reason', type: 'text', nullable: true })
  decisionReason: string | null;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt: Date | null;

  @Column({ name: 'release_reason', type: 'text', nullable: true })
  releaseReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
