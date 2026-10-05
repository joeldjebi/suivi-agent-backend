import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Compte de l'éditeur (super administrateur) : hors de toute structure. */
@Entity('platform_admins')
export class PlatformAdmin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  email: string;

  @Column({ name: 'password_hash', select: false })
  passwordHash: string;

  @Column({ name: 'first_name' })
  firstName: string;

  @Column({ name: 'last_name' })
  lastName: string;

  @Column({ name: 'is_active' })
  isActive: boolean;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  /** Secret TOTP chiffré (en attente tant que mfaEnabledAt est vide) */
  @Column({ name: 'mfa_secret', type: 'text', nullable: true, select: false })
  mfaSecret: string | null;

  /** Double authentification active depuis cette date */
  @Column({ name: 'mfa_enabled_at', type: 'timestamptz', nullable: true })
  mfaEnabledAt: Date | null;

  /** Empreintes SHA-256 des codes de secours non utilisés */
  @Column({
    name: 'mfa_recovery_codes',
    type: 'text',
    array: true,
    select: false,
  })
  mfaRecoveryCodes: string[];

  /** Dernier pas de 30 s accepté : un même code ne sert pas deux fois */
  @Column({
    name: 'mfa_last_step',
    type: 'bigint',
    nullable: true,
    select: false,
  })
  mfaLastStep: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

/** Journal des actions de l'éditeur. */
@Entity('platform_audit')
export class PlatformAudit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'admin_id', type: 'uuid', nullable: true })
  adminId: string | null;

  @Column()
  action: string;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId: string | null;

  @Column({ type: 'jsonb' })
  details: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  ip: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
