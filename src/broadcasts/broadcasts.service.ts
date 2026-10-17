import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/auth-user';
import { badRequest, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { PushService, type PushMessage } from '../common/push.service';
import type {
  BroadcastAudienceDto,
  ListBroadcastsQuery,
  SendBroadcastDto,
} from './broadcasts.dto';

/** Statut d'un envoi, d'après le suivi de ses destinataires. */
const STATUS_SQL = `CASE
    WHEN s.tracked = 0 THEN 'legacy'
    WHEN s.pending > 0 THEN 'pending'
    WHEN s.sent = 0 THEN 'failed'
    WHEN s.failed + s.no_device > 0 THEN 'partial'
    ELSE 'sent' END`;

/** Fenêtre de présence dans une zone : agents qui y ont travaillé ces 30 derniers jours. */
const RECENT_DAYS = 30;

/**
 * Notifications de l'administrateur à ses équipes : sur le téléphone (push) et dans la liste
 * des notifications de l'app. Les destinataires sont calculés au moment de l'envoi.
 *
 * - zones : agents des groupes rattachés à la zone et agents qui y ont travaillé récemment
 *   (zones libres comprises) ;
 * - missions : agent ou groupe assigné ; mission ouverte : agents de ses zones (comme ci-dessus).
 * Option « chefs » : chefs des groupes de ces agents (et des groupes rattachés).
 */
@Injectable()
export class BroadcastsService {
  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  /** Destinataires d'une audience (comptes actifs, agents et chefs d'équipe). */
  async recipients(audience: BroadcastAudienceDto): Promise<string[]> {
    const m = this.db.manager;
    const ids = (rows: { id: string }[]) => [...new Set(rows.map((r) => r.id))];
    const leads = audience.includeLeads === true;
    switch (audience.target) {
      case 'all':
      case 'agents':
      case 'leads': {
        const roles =
          audience.target === 'all'
            ? ['agent', 'team_lead']
            : [audience.target === 'agents' ? 'agent' : 'team_lead'];
        return ids(
          await m.query(
            `SELECT id FROM users WHERE is_active AND role = ANY($1)`,
            [roles],
          ),
        );
      }
      case 'users': {
        const wanted = [...new Set(audience.userIds ?? [])];
        if (!wanted.length)
          throw this.empty('Choisissez au moins une personne');
        const found = ids(
          await m.query(
            `SELECT id FROM users
             WHERE is_active AND role IN ('agent', 'team_lead') AND id = ANY($1)`,
            [wanted],
          ),
        );
        if (found.length !== wanted.length)
          throw badRequest(
            'UNKNOWN_RECIPIENT',
            'Certaines personnes choisies sont introuvables ou désactivées',
          );
        return found;
      }
      case 'zones': {
        const zoneIds = audience.zoneIds ?? [];
        if (!zoneIds.length) throw this.empty('Choisissez au moins une zone');
        return ids(
          await m.query(
            `WITH z AS (SELECT unnest($1::uuid[]) AS zone_id),
             zone_groups AS (
               SELECT gz.group_id FROM group_zones gz JOIN z USING (zone_id)),
             agents AS (
               SELECT u.id, u.group_id FROM users u
               WHERE u.role = 'agent' AND u.is_active AND (
                 u.group_id IN (SELECT group_id FROM zone_groups)
                 OR EXISTS (
                   SELECT 1 FROM work_days d JOIN z ON z.zone_id = d.zone_id
                   WHERE d.agent_id = u.id
                     AND d.work_date >= current_date - $3::int)))
             SELECT id FROM agents
             UNION
             SELECT g.leader_id FROM groups g
               JOIN users l ON l.id = g.leader_id AND l.is_active
             WHERE $2 AND g.is_active AND (
               g.id IN (SELECT group_id FROM zone_groups)
               OR g.id IN (SELECT group_id FROM agents))`,
            [zoneIds, leads, RECENT_DAYS],
          ),
        );
      }
      case 'missions': {
        const missionIds = audience.missionIds ?? [];
        if (!missionIds.length)
          throw this.empty('Choisissez au moins une mission');
        return ids(
          await m.query(
            `WITH ms AS (
               SELECT id, assignee_agent_id, assignee_group_id FROM missions
               WHERE id = ANY($1::uuid[])),
             open_zones AS (
               SELECT mz.zone_id FROM mission_zones mz JOIN ms ON ms.id = mz.mission_id
               WHERE ms.assignee_agent_id IS NULL AND ms.assignee_group_id IS NULL),
             zone_groups AS (
               SELECT gz.group_id FROM group_zones gz JOIN open_zones USING (zone_id)),
             targeted_groups AS (
               SELECT assignee_group_id AS id FROM ms WHERE assignee_group_id IS NOT NULL
               UNION SELECT group_id FROM zone_groups),
             agents AS (
               SELECT u.id, u.group_id FROM users u
               WHERE u.role = 'agent' AND u.is_active AND (
                 u.id IN (SELECT assignee_agent_id FROM ms)
                 OR u.group_id IN (SELECT id FROM targeted_groups)
                 OR EXISTS (
                   SELECT 1 FROM work_days d JOIN open_zones oz ON oz.zone_id = d.zone_id
                   WHERE d.agent_id = u.id
                     AND d.work_date >= current_date - $3::int)))
             SELECT id FROM agents
             UNION
             SELECT g.leader_id FROM groups g
               JOIN users l ON l.id = g.leader_id AND l.is_active
             WHERE $2 AND g.is_active AND (
               g.id IN (SELECT id FROM targeted_groups)
               OR g.id IN (SELECT group_id FROM agents))`,
            [missionIds, leads, RECENT_DAYS],
          ),
        );
      }
    }
  }

  private empty(message: string) {
    return badRequest('EMPTY_SELECTION', message);
  }

  /** Aperçu avant envoi : combien de personnes, dont combien joignables sur leur téléphone. */
  async preview(audience: BroadcastAudienceDto) {
    const ids = await this.recipients(audience);
    return this.describe(ids);
  }

  private async describe(ids: string[]) {
    const [counts] = await this.db.manager.query<
      { agents: number; leads: number }[]
    >(
      `SELECT count(*) FILTER (WHERE role = 'agent')::int AS agents,
              count(*) FILTER (WHERE role = 'team_lead')::int AS leads
       FROM users WHERE id = ANY($1)`,
      [ids],
    );
    const reachable = await this.reachable(ids);
    const sample = await this.db.manager.query<{ id: string; name: string }[]>(
      `SELECT id, first_name || ' ' || last_name AS name FROM users
       WHERE id = ANY($1) ORDER BY first_name, last_name LIMIT 8`,
      [ids],
    );
    return {
      total: ids.length,
      agents: counts.agents,
      leads: counts.leads,
      reachable,
      sample: sample.map((s) => s.name),
    };
  }

  /** Personnes ayant au moins un téléphone enregistré pour les notifications push. */
  private async reachable(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const [row] = await this.db.runAsSystem(() =>
      this.db.manager.query<{ n: number }[]>(
        `SELECT count(DISTINCT user_id)::int AS n FROM push_devices WHERE user_id = ANY($1)`,
        [ids],
      ),
    );
    return row.n;
  }

  async send(user: AuthUser, dto: SendBroadcastDto) {
    const recipients = await this.recipients(dto.audience);
    if (!recipients.length)
      throw badRequest(
        'NO_RECIPIENT',
        'Personne ne correspond à ces destinataires',
      );
    const m = this.db.manager;
    const title = dto.title.trim();
    const body = dto.body.trim();
    const reachable = await this.reachable(recipients);
    const [saved] = await m.query<{ id: string; createdAt: Date }[]>(
      `INSERT INTO broadcasts
         (tenant_id, author_id, title, body, audience, recipient_ids, reachable)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at AS "createdAt"`,
      [
        this.db.tenantId,
        user.id,
        title,
        body,
        JSON.stringify(dto.audience),
        recipients,
        reachable,
      ],
    );
    const message = {
      type: 'broadcast',
      title,
      body,
      data: { broadcastId: saved.id },
    };
    // Notification dans l'app ; l'envoi sur les téléphones est suivi personne par personne.
    const notes = await this.notifications.notify(recipients, message, {
      push: false,
    });
    await m.query(
      `INSERT INTO broadcast_deliveries (tenant_id, broadcast_id, user_id, notification_id)
       SELECT $1, $2, n.user_id, n.id FROM unnest($3::uuid[], $4::uuid[]) AS n(user_id, id)`,
      [
        this.db.tenantId,
        saved.id,
        notes.map((n) => n.userId),
        notes.map((n) => n.id),
      ],
    );
    this.deliverAfterCommit(saved.id, recipients, message);
    return {
      id: saved.id,
      recipients: recipients.length,
      reachable,
      createdAt: saved.createdAt,
    };
  }

  /** Envoi sur les téléphones une fois les données enregistrées ; résultat noté par personne. */
  private deliverAfterCommit(
    broadcastId: string,
    userIds: string[],
    message: PushMessage,
  ) {
    const tenantId = this.db.tenantId;
    this.db.afterCommit(() => {
      void this.record(tenantId, broadcastId, userIds, message);
    });
  }

  private async record(
    tenantId: string,
    broadcastId: string,
    userIds: string[],
    message: PushMessage,
  ) {
    const results = await this.push.deliver(tenantId, userIds, message);
    const groups = new Map<string, string[]>();
    for (const [userId, r] of results) {
      const key = `${r.status}|${r.code ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), userId]);
    }
    await this.db.runAsSystem(async () => {
      for (const [key, ids] of groups) {
        const [status, code] = key.split('|');
        await this.db.manager.query(
          `UPDATE broadcast_deliveries
           SET status = $3, error_code = nullif($4, ''), attempts = attempts + 1,
               last_attempt_at = now()
           WHERE broadcast_id = $1 AND user_id = ANY($2)`,
          [broadcastId, ids, status, code],
        );
      }
    });
  }

  /**
   * Historique des envois, le plus récent d'abord : statut (envoyé, partiel, échec, en
   * cours ; « legacy » pour les envois antérieurs au suivi) et compteurs par état.
   */
  async list(q: ListBroadcastsQuery) {
    const rows = await this.db.manager.query<
      (Record<string, unknown> & { total: number })[]
    >(
      `SELECT * , count(*) OVER ()::int AS total FROM (
         SELECT b.id, b.title, b.body, b.audience,
                cardinality(b.recipient_ids) AS recipients, b.reachable,
                b.created_at AS "createdAt",
                u.first_name || ' ' || u.last_name AS "authorName",
                s.sent, s.failed, s.no_device AS "noDevice", s.pending,
                (SELECT count(*)::int FROM notifications n
                 WHERE n.type = 'broadcast' AND n.data->>'broadcastId' = b.id::text
                   AND n.read_at IS NOT NULL) AS read,
                ${STATUS_SQL} AS status
         FROM broadcasts b
         LEFT JOIN users u ON u.id = b.author_id
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS tracked,
                  count(*) FILTER (WHERE status = 'sent')::int AS sent,
                  count(*) FILTER (WHERE status = 'failed')::int AS failed,
                  count(*) FILTER (WHERE status = 'no_device')::int AS no_device,
                  count(*) FILTER (WHERE status = 'pending')::int AS pending
           FROM broadcast_deliveries d WHERE d.broadcast_id = b.id) s
         WHERE ($1::text IS NULL OR b.title ILIKE '%' || $1 || '%')
       ) x
       WHERE ($2::text IS NULL OR x.status = $2)
       ORDER BY x."createdAt" DESC
       LIMIT $3 OFFSET $4`,
      [q.q?.trim() || null, q.status ?? null, q.limit, (q.page - 1) * q.limit],
    );
    return {
      items: rows.map((r) => {
        const item: Record<string, unknown> = { ...r };
        delete item.total;
        return item;
      }),
      total: rows[0]?.total ?? 0,
      page: q.page,
      limit: q.limit,
    };
  }

  /** Un envoi et ses destinataires : état de l'envoi, tentatives, lecture dans l'app. */
  async get(id: string) {
    const [broadcast] = await this.db.manager.query<
      (Record<string, unknown> & { recipientIds: string[] })[]
    >(
      `SELECT b.id, b.title, b.body, b.audience, b.created_at AS "createdAt",
              b.recipient_ids AS "recipientIds",
              u.first_name || ' ' || u.last_name AS "authorName"
       FROM broadcasts b LEFT JOIN users u ON u.id = b.author_id WHERE b.id = $1`,
      [id],
    );
    if (!broadcast) throw notFound('Envoi');
    const recipients = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT u.id AS "userId", trim(u.first_name || ' ' || u.last_name) AS name,
              u.role, u.phone, d.status, d.error_code AS "errorCode",
              coalesce(d.attempts, 0) AS attempts, d.last_attempt_at AS "lastAttemptAt",
              n.read_at AS "readAt"
       FROM unnest($2::uuid[]) AS r(id)
       JOIN users u ON u.id = r.id
       LEFT JOIN broadcast_deliveries d ON d.broadcast_id = $1 AND d.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT read_at FROM notifications n
         WHERE n.user_id = u.id AND n.type = 'broadcast'
           AND n.data->>'broadcastId' = $1::text
         LIMIT 1) n ON true
       ORDER BY (d.status = 'failed') DESC NULLS LAST, (d.status = 'no_device') DESC NULLS LAST,
                u.first_name, u.last_name`,
      [id, broadcast.recipientIds],
    );
    const rest: Record<string, unknown> = { ...broadcast };
    delete rest.recipientIds;
    return { ...rest, recipients };
  }

  /**
   * Renvoi sur les téléphones de destinataires choisis (sans nouvelle notification dans
   * l'app : pas de doublon) ; le résultat met à jour leur suivi.
   */
  async resend(id: string, userIds: string[]) {
    const m = this.db.manager;
    const [b] = await m.query<
      { title: string; body: string; recipientIds: string[] }[]
    >(
      `SELECT title, body, recipient_ids AS "recipientIds" FROM broadcasts WHERE id = $1`,
      [id],
    );
    if (!b) throw notFound('Envoi');
    const wanted = [...new Set(userIds)];
    if (wanted.some((u) => !b.recipientIds.includes(u)))
      throw badRequest(
        'NOT_A_RECIPIENT',
        'Seuls les destinataires de cet envoi peuvent le recevoir à nouveau',
      );
    const ids = (
      await m.query<{ id: string }[]>(
        `SELECT id FROM users WHERE is_active AND id = ANY($1)`,
        [wanted],
      )
    ).map((r) => r.id);
    if (!ids.length)
      throw badRequest('NO_RECIPIENT', 'Choisissez au moins une personne');
    // Envois antérieurs au suivi : la ligne de suivi est créée au premier renvoi.
    await m.query(
      `INSERT INTO broadcast_deliveries (tenant_id, broadcast_id, user_id, notification_id, status)
       SELECT $1::uuid, $2::uuid, u.id,
              (SELECT n.id FROM notifications n WHERE n.user_id = u.id AND n.type = 'broadcast'
                 AND n.data->>'broadcastId' = $4 LIMIT 1),
              'pending'
       FROM unnest($3::uuid[]) AS u(id)
       ON CONFLICT (broadcast_id, user_id) DO UPDATE SET status = 'pending'`,
      [this.db.tenantId, id, ids, id],
    );
    this.deliverAfterCommit(id, ids, {
      type: 'broadcast',
      title: b.title,
      body: b.body,
      data: { broadcastId: id },
    });
    return { resent: ids.length };
  }
}
