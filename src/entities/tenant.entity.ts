import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
