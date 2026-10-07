import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/auth-user';
import { badRequest } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import type { BroadcastAudienceDto, SendBroadcastDto } from './broadcasts.dto';

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
    await this.notifications.notify(recipients, {
      type: 'broadcast',
      title,
      body,
      data: { broadcastId: saved.id },
    });
    return {
      id: saved.id,
      recipients: recipients.length,
      reachable,
      createdAt: saved.createdAt,
    };
  }

  /** Historique des envois de la structure (les 100 derniers). */
  list() {
    return this.db.manager.query<Record<string, unknown>[]>(
      `SELECT b.id, b.title, b.body, b.audience,
              cardinality(b.recipient_ids) AS recipients, b.reachable,
              b.created_at AS "createdAt",
              u.first_name || ' ' || u.last_name AS "authorName"
       FROM broadcasts b LEFT JOIN users u ON u.id = b.author_id
       ORDER BY b.created_at DESC LIMIT 100`,
    );
  }
}
