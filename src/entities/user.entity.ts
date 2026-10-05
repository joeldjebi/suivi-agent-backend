import type { Role } from '@suivi/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column()
  email: string;

  @Column({ name: 'password_hash', select: false })
  passwordHash: string;

  @Column({ name: 'first_name' })
  firstName: string;

  @Column({ name: 'last_name' })
  lastName: string;

  @Column({ type: 'text', nullable: true })
  phone: string | null;

  @Column({ type: 'text' })
  role: Role;

  @Column({ name: 'group_id', type: 'uuid', nullable: true })
  groupId: string | null;

  @Column({ name: 'on_probation' })
  onProbation: boolean;

  @Column({ name: 'is_active' })
  isActive: boolean;

  /** Photo de profil (lue seulement par GET /users/:id/avatar) */
  @Column({ type: 'bytea', nullable: true, select: false })
  avatar: Buffer | null;

  @Column({ name: 'avatar_mime', type: 'text', nullable: true, select: false })
  avatarMime: string | null;

  /** Version de la photo (cache des applications), null sans photo */
  @Column({ name: 'avatar_version', type: 'integer', nullable: true })
  avatarVersion: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
