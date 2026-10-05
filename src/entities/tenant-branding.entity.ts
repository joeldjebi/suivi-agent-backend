import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('tenant_branding')
export class TenantBranding {
  @PrimaryColumn({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  /** Nom affiché dans l'app (par défaut : nom de la structure) */
  @Column({ name: 'display_name', type: 'text', nullable: true })
  displayName: string | null;

  /** Couleur principale, format #RRGGBB */
  @Column({ name: 'primary_color' })
  primaryColor: string;

  @Column({ name: 'welcome_message', type: 'text', nullable: true })
  welcomeMessage: string | null;

  /** Numéro à appeler en cas de problème (responsable, support) */
  @Column({ name: 'support_phone', type: 'text', nullable: true })
  supportPhone: string | null;

  @Column({ type: 'bytea', nullable: true, select: false })
  logo: Buffer | null;

  @Column({ name: 'logo_mime', type: 'text', nullable: true })
  logoMime: string | null;

  /** Incrémentée à chaque modification : l'app sait quand rafraîchir son cache. */
  @Column()
  version: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
