import type { MissionField, MissionPay } from '@suivi/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('mission_types')
export class MissionType {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'jsonb' })
  fields: MissionField[];

  @Column({ name: 'is_active' })
  isActive: boolean;

  /**
   * Rémunération des missions de ce type (administrateur) ; vide : grille de l'agent.
   * Une mission peut avoir ses propres conditions, qui priment.
   */
  @Column({ type: 'jsonb', nullable: true })
  pay: MissionPay | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
