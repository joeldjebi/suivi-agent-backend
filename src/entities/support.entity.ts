import type { SupportCategory, SupportStatus } from '@suivi/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Demande d'aide d'une structure à l'éditeur. */
@Entity('support_tickets')
export class SupportTicket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  /** Numéro lisible (#1001), commun à toute la plateforme. */
  @Column({ type: 'int', insert: false, update: false })
  number: number;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById: string | null;

  @Column()
  subject: string;

  @Column({ type: 'text' })
  category: SupportCategory;

  @Column({ type: 'text' })
  status: SupportStatus;

  /** Contexte envoyé avec la demande (page, navigateur, formule…). */
  @Column({ type: 'jsonb' })
  context: Record<string, unknown>;

  @Column({ name: 'last_author', type: 'text' })
  lastAuthor: 'tenant' | 'platform';

  @Column({ name: 'last_message_at', type: 'timestamptz' })
  lastMessageAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;
}

@Entity('support_messages')
export class SupportMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'ticket_id', type: 'uuid' })
  ticketId: string;

  @Column({ name: 'author_kind', type: 'text' })
  authorKind: 'tenant' | 'platform';

  @Column({ name: 'author_user_id', type: 'uuid', nullable: true })
  authorUserId: string | null;

  @Column({ name: 'platform_admin_id', type: 'uuid', nullable: true })
  platformAdminId: string | null;

  /** Nom affiché, figé au moment du message. */
  @Column({ name: 'author_name' })
  authorName: string;

  @Column({ type: 'text' })
  body: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

/** Article du manuel d'utilisation, commun à la plateforme. */
@Entity('doc_articles')
export class DocArticleEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  slug: string;

  @Column()
  section: string;

  @Column()
  title: string;

  @Column()
  summary: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'text', array: true })
  audience: string[];

  @Column({ type: 'int' })
  position: number;

  @Column()
  published: boolean;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;
}
