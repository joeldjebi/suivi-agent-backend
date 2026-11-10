import { Injectable, Logger } from '@nestjs/common';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { SecurityEvent } from '../entities';
import { DbService } from './db.service';

export interface SecurityEventInput {
  type: string;
  ip?: string | null;
  target?: string | null;
  path?: string | null;
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

  constructor(private readonly db: DbService) {}

  /** Enregistre un événement, sans bloquer l'appelant (« tire et oublie »). */
  record(input: SecurityEventInput): void {
    const entry = {
      type: input.type,
      ip: input.ip ?? null,
      target: input.target ?? null,
      path: input.path ?? null,
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

  /** Liste filtrée, la plus récente d'abord (pour le tableau de la console). */
  async list(query: SecurityEventsQuery) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    return this.db.runAsSystem(async () => {
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
      const [items, total] = await qb.getManyAndCount();
      return { items, total, page, limit };
    });
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
