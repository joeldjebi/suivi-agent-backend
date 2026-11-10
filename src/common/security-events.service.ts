import { Injectable, Logger } from '@nestjs/common';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { SecurityEvent } from '../entities';
import { DbService } from './db.service';
import { IpIntelService } from './ip-intel.service';

export interface SecurityEventInput {
  type: string;
  ip?: string | null;
  target?: string | null;
  path?: string | null;
  method?: string | null;
  referer?: string | null;
  userAgent?: string | null;
  tenantId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface SecurityEventsQuery {
  type?: string;
  ip?: string;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Journal des événements de sécurité (« attaques ») montrés à l'éditeur. L'enregistrement
 * ne doit JAMAIS bloquer ni faire échouer la requête d'origine : il est lancé sans attendre
 * et les erreurs sont avalées. La table est de plateforme (événements souvent anonymes), on
 * écrit et lit en contournant la RLS.
 */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger(SecurityEventsService.name);

  constructor(
    private readonly db: DbService,
    private readonly ipIntel: IpIntelService,
  ) {}

  /** Enregistre un événement, sans bloquer l'appelant (« tire et oublie »). */
  record(input: SecurityEventInput): void {
    const entry = {
      type: input.type,
      ip: input.ip ?? null,
      target: input.target ?? null,
      path: input.path ?? null,
      method: input.method ?? null,
      referer: input.referer?.slice(0, 500) ?? null,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
      tenantId: input.tenantId ?? null,
      details: input.details ?? null,
    };
    void this.db
      .runAsSystem(() =>
        this.db.manager.insert(
          SecurityEvent,
          entry as unknown as QueryDeepPartialEntity<SecurityEvent>,
        ),
      )
      .catch((error) =>
        this.logger.error('Échec du journal de sécurité', error as Error),
      );
  }

  /** Liste filtrée, la plus récente d'abord, chaque ligne enrichie des infos d'IP. */
  async list(query: SecurityEventsQuery) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const { items, total } = await this.db.runAsSystem(async () => {
      const qb = this.db.manager
        .createQueryBuilder(SecurityEvent, 'e')
        .orderBy('e.created_at', 'DESC')
        .skip((page - 1) * limit)
        .take(limit);
      if (query.type) qb.andWhere('e.type = :type', { type: query.type });
      if (query.ip) qb.andWhere('e.ip = :ip', { ip: query.ip });
      if (query.search)
        qb.andWhere('(e.target ILIKE :q OR e.ip ILIKE :q)', {
          q: `%${query.search}%`,
        });
      const [rows, count] = await qb.getManyAndCount();
      return { items: rows, total: count };
    });
    const intel = await this.ipIntel.lookupMany(
      items.map((e) => e.ip).filter((ip): ip is string => !!ip),
    );
    return {
      items: items.map((e) => ({
        ...e,
        intel: e.ip ? (intel.get(e.ip) ?? null) : null,
      })),
      total,
      page,
      limit,
    };
  }

  /** Détail d'un événement + renseignements sur son adresse IP. */
  async detail(id: string) {
    const event = await this.db.runAsSystem(() =>
      this.db.manager.findOneBy(SecurityEvent, { id }),
    );
    if (!event) return null;
    const intel = event.ip ? await this.ipIntel.lookup(event.ip) : null;
    return { ...event, intel };
  }

  /**
   * Attaquants regroupés par adresse IP : nombre, types, première/dernière tentative, cibles
   * et chemins visés, enrichis de la géolocalisation. Les plus actifs d'abord.
   */
  async attackers(query: { days?: number; page?: number; limit?: number }) {
    const days = Math.min(90, Math.max(1, query.days ?? 7));
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const { rows, total } = await this.db.runAsSystem(async () => {
      const [{ total }] = await this.db.manager.query<{ total: string }[]>(
        `SELECT count(DISTINCT ip)::int AS total FROM security_events
         WHERE ip IS NOT NULL AND created_at >= now() - ($1 || ' days')::interval`,
        [days],
      );
      const rows = await this.db.manager.query<
        {
          ip: string;
          count: string;
          types: string[];
          firstSeen: Date;
          lastSeen: Date;
          targets: string[];
        }[]
      >(
        `SELECT ip, count(*)::int AS count,
            array_agg(DISTINCT type) AS types,
            min(created_at) AS "firstSeen",
            max(created_at) AS "lastSeen",
            (array_remove(array_agg(DISTINCT target), NULL))[1:5] AS targets
         FROM security_events
         WHERE ip IS NOT NULL AND created_at >= now() - ($1 || ' days')::interval
         GROUP BY ip
         ORDER BY count DESC, "lastSeen" DESC
         LIMIT $2 OFFSET $3`,
        [days, limit, (page - 1) * limit],
      );
      return { rows, total: Number(total) };
    });
    const intel = await this.ipIntel.lookupMany(rows.map((r) => r.ip));
    return {
      items: rows.map((r) => ({
        ip: r.ip,
        count: Number(r.count),
        types: r.types,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        targets: r.targets ?? [],
        intel: intel.get(r.ip) ?? null,
      })),
      total,
      page,
      limit,
    };
  }

  /** Compteurs par type (24 h, 7 j), total, principales IP et série quotidienne (graphe). */
  async summary() {
    return this.db.runAsSystem(async () => {
      const byType = await this.db.manager.query<
        { type: string; last24h: string; last7d: string }[]
      >(`
        SELECT type,
          count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS "last24h",
          count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS "last7d"
        FROM security_events
        WHERE created_at >= now() - interval '7 days'
        GROUP BY type`);
      const topIps = await this.db.manager.query<
        { ip: string; count: string }[]
      >(`
        SELECT ip, count(*)::int AS count
        FROM security_events
        WHERE ip IS NOT NULL AND created_at >= now() - interval '7 days'
        GROUP BY ip ORDER BY count DESC LIMIT 10`);
      const daily = await this.db.manager.query<
        { day: string; type: string; count: string }[]
      >(`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, type,
          count(*)::int AS count
        FROM security_events
        WHERE created_at >= now() - interval '14 days'
        GROUP BY 1, 2 ORDER BY 1`);
      return {
        byType: byType.map((r) => ({
          type: r.type,
          last24h: Number(r.last24h),
          last7d: Number(r.last7d),
        })),
        topIps: topIps.map((r) => ({ ip: r.ip, count: Number(r.count) })),
        daily: daily.map((r) => ({
          day: r.day,
          type: r.type,
          count: Number(r.count),
        })),
      };
    });
  }

  /** Purge les événements plus vieux que `days` jours (tâche quotidienne). */
  async purge(days = 90): Promise<number> {
    return this.db.runAsSystem(async () => {
      const result = await this.db.manager
        .createQueryBuilder()
        .delete()
        .from(SecurityEvent)
        .where(`created_at < now() - (:days || ' days')::interval`, { days })
        .execute();
      return result.affected ?? 0;
    });
  }
}
