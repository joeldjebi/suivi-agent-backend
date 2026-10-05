import type { Polygon } from 'geojson';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('zones')
export class Zone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column()
  name: string;

  @Column({ type: 'geometry', spatialFeatureType: 'Polygon', srid: 4326 })
  area: Polygon;

  /** Nombre maximum d'agents (RG-02). null = illimité. */
  @Column({ type: 'integer', nullable: true })
  capacity: number | null;

  /** Critère du mode mixte (RG-23). */
  @Column()
  sensitive: boolean;

  /** Sans groupes : zone réservée aux agents autorisés (RG-15). */
  @Column()
  restricted: boolean;

  @Column({ name: 'is_active' })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
