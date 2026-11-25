import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Lecture de la vidéo de présentation (page publique /video). Une ligne par visionnage,
 * mise à jour en continu (temps regardé, % atteint). `prospect_id` est renseigné quand le
 * lien est personnalisé (…/video?p=<id>), pour savoir QUELLE entreprise a regardé. Table de
 * plateforme (pas de tenant), lue par l'éditeur. Voir VideoService.
 */
@Entity('video_views')
export class VideoView {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Identifiant du visionnage, généré côté navigateur, pour cumuler les envois. */
  @Index({ unique: true })
  @Column({ name: 'view_id', type: 'text' })
  viewId: string;

  @Column({ name: 'prospect_id', type: 'uuid', nullable: true })
  prospectId: string | null;

  /** Temps réellement regardé, en secondes. */
  @Column({ type: 'int', default: 0 })
  seconds: number;

  /** Pourcentage maximal atteint dans la vidéo (0–100). */
  @Column({ type: 'int', default: 0 })
  percent: number;

  @Column({ type: 'int', nullable: true })
  duration: number | null;

  @Column({ type: 'text', nullable: true })
  orientation: string | null;

  @Column({ type: 'text', nullable: true })
  ip: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @Column({ type: 'text', nullable: true })
  referer: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
