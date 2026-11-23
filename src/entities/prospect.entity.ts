import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Prospect commercial (démarchage sortant) suivi par l'éditeur : entreprise à contacter,
 * ses infos de contact, son canal et son statut d'avancement. Table de plateforme (pas de
 * tenant) : lue et écrite uniquement par l'éditeur. Voir ProspectsService.
 */
@Entity('prospects')
export class Prospect {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  entreprise: string;

  @Column({ type: 'text', nullable: true })
  secteur: string | null;

  @Column({ type: 'text', nullable: true })
  pays: string | null;

  @Column({ type: 'text', nullable: true })
  ville: string | null;

  @Column({ name: 'contact_nom', type: 'text', nullable: true })
  contactNom: string | null;

  @Column({ type: 'text', nullable: true })
  telephone: string | null;

  @Column({ type: 'text', nullable: true })
  email: string | null;

  /** Canal privilégié : whatsapp, email, appel, linkedin… (texte libre). */
  @Column({ type: 'text', nullable: true })
  canal: string | null;

  @Index()
  @Column({ type: 'text', default: 'a_contacter' })
  statut: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** Modèle de message (e-mail ou WhatsApp) à envoyer aux prospects. Un par canal. */
@Entity('prospect_templates')
export class ProspectTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 'email' | 'whatsapp'. */
  @Column({ type: 'text' })
  canal: string;

  /** Objet (e-mail uniquement). */
  @Column({ type: 'text', nullable: true })
  objet: string | null;

  /** Corps du message, avec variables {{entreprise}} et {{contact}}. */
  @Column({ type: 'text' })
  corps: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
