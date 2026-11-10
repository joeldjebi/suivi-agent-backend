import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Cache des renseignements d'une adresse IP (ipinfo.io). Voir IpIntelService. */
@Entity('ip_intel')
export class IpIntel {
  @PrimaryColumn({ type: 'text' })
  ip: string;

  @Column({ type: 'text', nullable: true })
  country: string | null;

  @Column({ type: 'text', nullable: true })
  region: string | null;

  @Column({ type: 'text', nullable: true })
  city: string | null;

  /** « latitude,longitude » renvoyé par ipinfo. */
  @Column({ type: 'text', nullable: true })
  loc: string | null;

  /** Opérateur / hébergeur (ASN + nom). */
  @Column({ type: 'text', nullable: true })
  org: string | null;

  @Column({ type: 'text', nullable: true })
  postal: string | null;

  @Column({ type: 'text', nullable: true })
  timezone: string | null;

  @Column({ type: 'text', nullable: true })
  hostname: string | null;

  /** Indicateurs VPN/proxy/hébergeur (offre payante ipinfo ; null sinon). */
  @Column({ type: 'jsonb', nullable: true })
  privacy: Record<string, unknown> | null;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt: Date;
}
