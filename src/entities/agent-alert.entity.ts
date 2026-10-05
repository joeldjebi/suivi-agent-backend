import type { AlertType } from '@suivi/shared';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Alerte d'un responsable sur un agent ; se referme quand la situation se règle. */
@Entity('agent_alerts')
export class AgentAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @Column({ name: 'day_id', type: 'uuid', nullable: true })
  dayId: string | null;

  @Column({ type: 'text' })
  type: AlertType;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'jsonb' })
  data: Record<string, unknown>;

  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  @Column({ name: 'acknowledged_by_id', type: 'uuid', nullable: true })
  acknowledgedById: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;
}
