import type { MissionPay, MissionStatus, ProgressMethod } from '@suivi/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

const numeric = {
  to: (value: number) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('missions')
export class Mission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'type_id', type: 'uuid' })
  typeId: string;

  @Column()
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'assignee_agent_id', type: 'uuid', nullable: true })
  assigneeAgentId: string | null;

  @Column({ name: 'assignee_group_id', type: 'uuid', nullable: true })
  assigneeGroupId: string | null;

  @Column({ name: 'progress_method', type: 'text' })
  progressMethod: ProgressMethod;

  @Column({ name: 'target_value', type: 'numeric', transformer: numeric })
  targetValue: number;

  /** Champ numérique additionné quand la méthode est « field_sum » (RG-36). */
  @Column({ name: 'sum_field_key', type: 'text', nullable: true })
  sumFieldKey: string | null;

  @Column({ name: 'due_date', type: 'timestamptz', nullable: true })
  dueDate: Date | null;

  @Column({ type: 'text' })
  status: MissionStatus;

  /** Une mission désactivée n'est plus proposée aux agents et n'accepte plus de formulaires. */
  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById: string | null;

  /** Rémunération propre à la mission ; vide : grille de l'agent (administrateur seulement). */
  @Column({ type: 'jsonb', nullable: true })
  pay: MissionPay | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
