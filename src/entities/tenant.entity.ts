import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TenantApprovalStatus } from '@suivi/shared';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  /** Notes internes de l'éditeur (jamais montrées à la structure) */
  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'contact_phone', type: 'text', nullable: true })
  contactPhone: string | null;

  /** Validation par l'éditeur : « pending » à l'inscription, « approved » une fois validée. */
  @Column({ name: 'approval_status', type: 'text', default: 'approved' })
  approvalStatus: TenantApprovalStatus;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy: string | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
