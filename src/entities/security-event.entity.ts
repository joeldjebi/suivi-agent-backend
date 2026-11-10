import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Événement de sécurité (« attaque ») journalisé pour l'éditeur. Voir SecurityEventsService. */
@Entity('security_events')
export class SecurityEvent {
  @PrimaryGeneratedColumn('identity', { type: 'bigint' })
  id: string;

  @Index()
  @Column()
  type: string;

  @Column({ type: 'text', nullable: true })
  ip: string | null;

  /** Cible visée : email ou numéro d'un compte, nom d'une structure… */
  @Column({ type: 'text', nullable: true })
  target: string | null;

  @Column({ type: 'text', nullable: true })
  path: string | null;

  @Column({ type: 'text', nullable: true })
  method: string | null;

  @Column({ type: 'text', nullable: true })
  referer: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
