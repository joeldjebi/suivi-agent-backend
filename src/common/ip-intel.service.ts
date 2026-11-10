import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { IpIntel } from '../entities';
import { DbService } from './db.service';

/** Au-delà de cette ancienneté, on réinterroge ipinfo pour rafraîchir. */
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

interface IpInfoResponse {
  ip?: string;
  hostname?: string;
  city?: string;
  region?: string;
  country?: string;
  loc?: string;
  org?: string;
  postal?: string;
  timezone?: string;
  bogon?: boolean;
  privacy?: Record<string, unknown>;
}

/** Adresse privée / locale : pas de géolocalisation possible, on n'interroge pas ipinfo. */
function isPrivate(ip: string): boolean {
  return (
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/**
 * Renseignements sur une adresse IP (pays, ville, opérateur…) via ipinfo.io, mis en cache en
 * base pour ne pas réinterroger. Désactivé si IPINFO_TOKEN n'est pas configuré : on renvoie
 * alors seulement ce qui est déjà en cache (souvent rien). N'interroge jamais sur le chemin
 * d'une requête utilisateur : seulement quand l'éditeur consulte le journal.
 */
@Injectable()
export class IpIntelService {
  private readonly logger = new Logger(IpIntelService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
  ) {}

  get enabled(): boolean {
    return !!this.config.get<string>('IPINFO_TOKEN');
  }

  /** Renseigne plusieurs adresses d'un coup : cache d'abord, puis ipinfo pour les manquantes. */
  async lookupMany(ips: string[]): Promise<Map<string, IpIntel>> {
    const unique = [...new Set(ips.filter((ip) => ip && !isPrivate(ip)))];
    const byIp = new Map<string, IpIntel>();
    if (unique.length === 0) return byIp;
    const cached = await this.db.runAsSystem(() =>
      this.db.manager.findBy(IpIntel, { ip: In(unique) }),
    );
    for (const row of cached) byIp.set(row.ip, row);
    const now = Date.now();
    const toFetch = unique.filter((ip) => {
      const hit = byIp.get(ip);
      return !hit || now - hit.fetchedAt.getTime() > MAX_AGE_MS;
    });
    if (!toFetch.length || !this.enabled) return byIp;
    // On interroge au plus 20 adresses par consultation (limites d'ipinfo).
    for (const ip of toFetch.slice(0, 20)) {
      const fresh = await this.fetchAndStore(ip);
      if (fresh) byIp.set(ip, fresh);
    }
    return byIp;
  }

  async lookup(ip: string): Promise<IpIntel | null> {
    return (await this.lookupMany([ip])).get(ip) ?? null;
  }

  private async fetchAndStore(ip: string): Promise<IpIntel | null> {
    const token = this.config.get<string>('IPINFO_TOKEN');
    if (!token) return null;
    try {
      const res = await fetch(
        `https://ipinfo.io/${encodeURIComponent(ip)}?token=${token}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as IpInfoResponse;
      if (data.bogon) return null;
      const row: IpIntel = {
        ip,
        country: data.country ?? null,
        region: data.region ?? null,
        city: data.city ?? null,
        loc: data.loc ?? null,
        org: data.org ?? null,
        postal: data.postal ?? null,
        timezone: data.timezone ?? null,
        hostname: data.hostname ?? null,
        privacy: data.privacy ?? null,
        fetchedAt: new Date(),
      };
      await this.db.runAsSystem(() =>
        this.db.manager
          .createQueryBuilder()
          .insert()
          .into(IpIntel)
          .values(row as unknown as QueryDeepPartialEntity<IpIntel>)
          .orUpdate(
            [
              'country',
              'region',
              'city',
              'loc',
              'org',
              'postal',
              'timezone',
              'hostname',
              'privacy',
              'fetched_at',
            ],
            ['ip'],
          )
          .execute(),
      );
      return row;
    } catch (e) {
      this.logger.error(`ipinfo indisponible pour ${ip} : ${String(e)}`);
      return null;
    }
  }
}
