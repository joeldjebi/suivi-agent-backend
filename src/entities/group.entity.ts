import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('groups')
export class Group {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column()
  name: string;

  @Column({ name: 'leader_id', type: 'uuid', nullable: true })
  leaderId: string | null;

  /** Un groupe désactivé n'ouvre plus de zones à ses agents et ne donne plus de droits à son chef. */
  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /** Durée de travail attendue par jour, en minutes ; vide : celle du niveau au-dessus */
  @Column({ name: 'workday_minutes', type: 'integer', nullable: true })
  workdayMinutes: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
