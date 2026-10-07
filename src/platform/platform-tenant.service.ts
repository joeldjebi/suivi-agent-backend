import { Injectable } from '@nestjs/common';
import { Feature, SubscriptionStatus } from '@suivi/shared';
import { effectiveSettings } from '../common/access.service';
import { notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import type { Invoice, Subscription, TenantSettings } from '../entities';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { TenantActivityQuery, TenantUsersQuery } from './platform.dto';

const DAY = 86400_000;

/** Ligne sans le total de pagination. */
function withoutTotal(row: Record<string, unknown>) {
  const copy = { ...row };
  delete copy.total;
  return copy;
}

export interface TenantAlert {
  level: 'critical' | 'warning' | 'info';
  code: string;
  message: string;
}

/**
 * Lecture détaillée d'une structure pour la console éditeur (onglets de la fiche).
 * La requête s'exécute hors structure : chaque requête filtre donc explicitement sur
 * `tenant_id`. Aucune position d'agent n'est exposée.
 */
@Injectable()
export class PlatformTenantService {
  constructor(
    private readonly db: DbService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  private async assertExists(tenantId: string) {
    const [found] = await this.db.manager.query<unknown[]>(
      `SELECT 1 FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (!found) throw notFound('Structure');
  }

  /** Points d'attention de la fiche, du plus grave au moins grave. */
  async alerts(
    tenantId: string,
    data: {
      subscription: Subscription | null;
      usage: {
        agents: { used: number; limit: number };
        leads: { used: number; limit: number };
      } | null;
      invoices: Invoice[];
      lastActivity: Date | string | null;
      activeAgents: number;
    },
  ): Promise<TenantAlert[]> {
    const alerts: TenantAlert[] = [];
    const sub = data.subscription;
    const now = Date.now();
    if (sub?.status === SubscriptionStatus.Suspended)
      alerts.push({
        level: 'critical',
        code: 'suspended',
        message: sub.manualSuspension
          ? `Suspendue par l’éditeur : ${sub.suspensionReason ?? 'sans motif'}`
          : 'Suspendue pour impayé',
      });
    const overdue = data.invoices.filter(
      (i) => i.status === 'pending' && new Date(i.dueAt).getTime() < now,
    );
    if (overdue.length)
      alerts.push({
        level: 'critical',
        code: 'overdue',
        message: `${overdue.length} facture${overdue.length > 1 ? 's échues' : ' échue'} : ${overdue
          .reduce((s, i) => s + i.amount, 0)
          .toLocaleString(
            'fr-FR',
          )} ${overdue[0].currency === 'XOF' ? 'FCFA' : overdue[0].currency}`,
      });
    if (
      sub?.status === SubscriptionStatus.Trialing &&
      sub.trialEndsAt &&
      sub.trialEndsAt.getTime() - now < 7 * DAY
    ) {
      const days = Math.max(
        0,
        Math.ceil((sub.trialEndsAt.getTime() - now) / DAY),
      );
      alerts.push({
        level: 'warning',
        code: 'trial_ending',
        message:
          days === 0
            ? 'L’essai se termine aujourd’hui'
            : `L’essai se termine dans ${days} jour${days > 1 ? 's' : ''}`,
      });
    }
    if (data.usage && data.usage.agents.used > data.usage.agents.limit)
      alerts.push({
        level: 'warning',
        code: 'over_quota',
        message: `${data.usage.agents.used} agents actifs pour ${data.usage.agents.limit} autorisés`,
      });
    if (data.usage && data.usage.leads.used > data.usage.leads.limit)
      alerts.push({
        level: 'warning',
        code: 'over_quota_leads',
        message: `${data.usage.leads.used} chefs d’équipe actifs pour ${data.usage.leads.limit} autorisés`,
      });
    const last = data.lastActivity
      ? new Date(data.lastActivity).getTime()
      : null;
    if (data.activeAgents > 0 && last === null)
      alerts.push({
        level: 'warning',
        code: 'never_used',
        message:
          'Aucune journée de travail depuis la création : accompagner la prise en main',
      });
    else if (last !== null && now - last > 14 * DAY)
      alerts.push({
        level: 'warning',
        code: 'inactive',
        message: `Aucune journée de travail depuis ${Math.floor((now - last) / DAY)} jours`,
      });
    if (data.activeAgents === 0)
      alerts.push({
        level: 'info',
        code: 'no_agents',
        message: 'Aucun agent actif',
      });
    const [{ lastAdminLogin }] = await this.db.manager.query<
      { lastAdminLogin: Date | null }[]
    >(
      `SELECT max(l.created_at) AS "lastAdminLogin"
       FROM audit_logs l JOIN users u ON u.id = l.user_id
       WHERE l.tenant_id = $1 AND l.action = 'auth.login' AND u.role = 'admin'`,
      [tenantId],
    );
    if (!lastAdminLogin || now - new Date(lastAdminLogin).getTime() > 30 * DAY)
      alerts.push({
        level: 'info',
        code: 'admin_absent',
        message: lastAdminLogin
          ? 'Aucun administrateur connecté depuis plus de 30 jours'
          : 'Aucun administrateur ne s’est encore connecté',
      });
    return alerts;
  }

  /** Comptes de la structure avec leur activité (30 derniers jours). */
  async users(tenantId: string, query: TenantUsersQuery) {
    await this.assertExists(tenantId);
    const { page, limit } = query;
    const rows = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName", u.email, u.phone, u.role,
              u.is_active AS "isActive", u.on_probation AS "onProbation", u.created_at AS "createdAt",
              g.name AS "groupName",
              (SELECT max(l.created_at) FROM audit_logs l
                 WHERE l.user_id = u.id AND l.action = 'auth.login') AS "lastLoginAt",
              (SELECT to_char(max(d.work_date), 'YYYY-MM-DD') FROM work_days d WHERE d.agent_id = u.id) AS "lastDay",
              (SELECT count(*) FROM work_days d
                 WHERE d.agent_id = u.id AND d.work_date >= current_date - 30)::int AS "days30",
              (SELECT count(*) FROM mission_submissions s
                 WHERE s.agent_id = u.id AND s.submitted_at >= now() - interval '30 days')::int AS "forms30",
              EXISTS (SELECT 1 FROM work_days d
                 WHERE d.agent_id = u.id AND d.status IN ('active', 'paused')) AS working,
              count(*) OVER()::int AS total
       FROM users u LEFT JOIN groups g ON g.id = u.group_id
       WHERE u.tenant_id = $1
         AND ($2::text IS NULL OR u.role = $2)
         AND ($3::text IS NULL OR ($3 = 'active' AND u.is_active) OR ($3 = 'inactive' AND NOT u.is_active))
         AND ($4::text IS NULL OR u.first_name || ' ' || u.last_name ILIKE '%' || $4 || '%'
              OR u.email ILIKE '%' || $4 || '%' OR u.phone LIKE '%' || regexp_replace($4, '\\D', '', 'g') || '%')
       ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'team_lead' THEN 1 ELSE 2 END,
                u.last_name, u.first_name
       LIMIT $5 OFFSET $6`,
      [
        tenantId,
        query.role ?? null,
        query.status ?? null,
        query.search?.trim() || null,
        limit,
        (page - 1) * limit,
      ],
    );
    const [summary] = await this.db.manager.query<Record<string, number>[]>(
      `SELECT count(*) FILTER (WHERE role = 'admin')::int AS admins,
              count(*) FILTER (WHERE role = 'team_lead')::int AS leads,
              count(*) FILTER (WHERE role = 'agent')::int AS agents,
              count(*) FILTER (WHERE is_active)::int AS active,
              count(*) FILTER (WHERE NOT is_active)::int AS inactive,
              count(*) FILTER (WHERE role = 'agent' AND is_active AND EXISTS (
                SELECT 1 FROM work_days d WHERE d.agent_id = users.id AND d.status IN ('active', 'paused')))::int AS working,
              count(*) FILTER (WHERE role = 'agent' AND is_active AND NOT EXISTS (
                SELECT 1 FROM work_days d WHERE d.agent_id = users.id
                  AND d.work_date >= current_date - 30))::int AS idle30
       FROM users WHERE tenant_id = $1`,
      [tenantId],
    );
    const total = (rows[0]?.total as number | undefined) ?? 0;
    return {
      items: rows.map(withoutTotal),
      total,
      page,
      limit,
      summary,
    };
  }

  /** Groupes, leurs chefs et leurs zones. */
  async groups(tenantId: string) {
    await this.assertExists(tenantId);
    return this.db.manager.query<Record<string, unknown>[]>(
      `SELECT g.id, g.name, g.is_active AS "isActive", g.created_at AS "createdAt",
              CASE WHEN l.id IS NULL THEN NULL ELSE l.first_name || ' ' || l.last_name END AS "leaderName",
              (SELECT count(*) FROM users u WHERE u.group_id = g.id AND u.role = 'agent' AND u.is_active)::int AS agents,
              ARRAY(SELECT z.name FROM group_zones gz JOIN zones z ON z.id = gz.zone_id
                    WHERE gz.group_id = g.id ORDER BY z.name) AS zones,
              (SELECT count(*) FROM work_days d JOIN users u ON u.id = d.agent_id
                 WHERE u.group_id = g.id AND d.work_date >= current_date - 30)::int AS "days30"
       FROM groups g LEFT JOIN users l ON l.id = g.leader_id
       WHERE g.tenant_id = $1
       ORDER BY g.is_active DESC, g.name`,
      [tenantId],
    );
  }

  /** Terrain : zones (avec leur tracé), activité quotidienne, missions et formulaires. */
  async field(tenantId: string) {
    await this.assertExists(tenantId);
    const m = this.db.manager;
    const zones = await m.query<Record<string, unknown>[]>(
      `SELECT z.id, z.name, z.capacity, z.sensitive, z.restricted, z.is_active AS "isActive",
              ST_AsGeoJSON(z.area)::json AS area,
              (SELECT count(*) FROM work_days d
                 WHERE d.zone_id = z.id AND d.status IN ('active', 'paused'))::int AS "workingNow",
              (SELECT count(*) FROM work_days d
                 WHERE d.zone_id = z.id AND d.work_date >= current_date - 30)::int AS "days30"
       FROM zones z WHERE z.tenant_id = $1
       ORDER BY z.is_active DESC, z.name`,
      [tenantId],
    );
    const daily = await m.query<
      { date: string; days: number; agents: number; forms: number }[]
    >(
      `SELECT to_char(g.day, 'YYYY-MM-DD') AS date,
              (SELECT count(*) FROM work_days d WHERE d.tenant_id = $1 AND d.work_date = g.day::date)::int AS days,
              (SELECT count(DISTINCT d.agent_id) FROM work_days d
                 WHERE d.tenant_id = $1 AND d.work_date = g.day::date)::int AS agents,
              (SELECT count(*) FROM mission_submissions s
                 WHERE s.tenant_id = $1 AND s.submitted_at::date = g.day::date)::int AS forms
       FROM generate_series(current_date - 29, current_date, interval '1 day') AS g(day)
       ORDER BY g.day`,
      [tenantId],
    );
    const [days] = await m.query<Record<string, number>[]>(
      `SELECT count(*) FILTER (WHERE status IN ('active', 'paused'))::int AS "workingNow",
              count(*) FILTER (WHERE work_date >= current_date - 30)::int AS "days30",
              count(*) FILTER (WHERE work_date >= current_date - 30 AND end_reason = 'auto_reset')::int AS "autoClosed30",
              coalesce(round(avg(extract(epoch FROM (coalesce(ended_at, now()) - started_at)) / 3600)
                FILTER (WHERE work_date >= current_date - 30 AND ended_at IS NOT NULL)::numeric, 1), 0)::float8 AS "avgHours30"
       FROM work_days WHERE tenant_id = $1`,
      [tenantId],
    );
    const [missions] = await m.query<Record<string, number>[]>(
      `SELECT count(*) FILTER (WHERE is_active)::int AS active,
              count(*) FILTER (WHERE is_active AND status = 'achieved')::int AS achieved,
              count(*) FILTER (WHERE is_active AND status <> 'achieved' AND due_date < now())::int AS late,
              (SELECT count(*) FROM mission_types t WHERE t.tenant_id = $1)::int AS types,
              (SELECT count(*) FROM mission_submissions s
                 WHERE s.tenant_id = $1 AND s.submitted_at >= now() - interval '30 days')::int AS "forms30",
              (SELECT count(*) FROM mission_submissions s
                 WHERE s.tenant_id = $1 AND s.status = 'rejected'
                   AND s.submitted_at >= now() - interval '30 days')::int AS "rejected30"
       FROM missions WHERE tenant_id = $1`,
      [tenantId],
    );
    const recentMissions = await m.query<Record<string, unknown>[]>(
      `SELECT m.id, m.title, m.status, m.due_date AS "dueDate", m.is_active AS "isActive",
              t.name AS "typeName",
              coalesce(g.name, a.first_name || ' ' || a.last_name) AS assignee,
              (SELECT count(*) FROM mission_submissions s WHERE s.mission_id = m.id)::int AS submissions
       FROM missions m
       JOIN mission_types t ON t.id = m.type_id
       LEFT JOIN groups g ON g.id = m.assignee_group_id
       LEFT JOIN users a ON a.id = m.assignee_agent_id
       WHERE m.tenant_id = $1
       ORDER BY m.created_at DESC LIMIT 10`,
      [tenantId],
    );
    return {
      zones,
      daily,
      days,
      missions,
      recentMissions,
    };
  }

  /**
   * Configuration : réglages enregistrés et en vigueur (limités par la formule), apparence,
   * rémunération, et usage réel de chaque avantage de la formule.
   */
  async config(tenantId: string) {
    await this.assertExists(tenantId);
    const m = this.db.manager;
    const [settings] = await m.query<TenantSettings[]>(
      `SELECT use_groups AS "useGroups", zone_access_without_groups AS "zoneAccessWithoutGroups",
              zone_required AS "zoneRequired", approval_mode AS "approvalMode", mixed_criteria AS "mixedCriteria",
              request_expiration_minutes AS "requestExpirationMinutes",
              allow_zone_change_before_start AS "allowZoneChangeBeforeStart",
              start_while_pending AS "startWhilePending", daily_reset_time AS "dailyResetTime",
              timezone, track_during_pause AS "trackDuringPause", auto_end_day_at_reset AS "autoEndDayAtReset",
              signal_lost_minutes AS "signalLostMinutes", position_retention_days AS "positionRetentionDays",
              zone_exit_tolerance_meters AS "zoneExitToleranceMeters",
              zone_exit_alert_minutes AS "zoneExitAlertMinutes",
              updated_at AS "updatedAt"
       FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    const summary = await this.subscriptions.summary(tenantId);
    const [branding] = await m.query<Record<string, unknown>[]>(
      `SELECT display_name AS "displayName", primary_color AS "primaryColor",
              welcome_message AS "welcomeMessage", support_phone AS "supportPhone",
              (logo IS NOT NULL) AS "hasLogo", version, updated_at AS "updatedAt"
       FROM tenant_branding WHERE tenant_id = $1`,
      [tenantId],
    );
    const [use] = await m.query<Record<string, number>[]>(
      `SELECT (SELECT count(*) FROM groups WHERE tenant_id = $1 AND is_active)::int AS groups,
              (SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'team_lead' AND is_active)::int AS leads,
              (SELECT count(*) FROM missions WHERE tenant_id = $1 AND is_active)::int AS missions,
              (SELECT count(*) FROM pay_grids WHERE tenant_id = $1 AND is_active)::int AS "payGrids",
              (SELECT count(*) FROM pay_runs WHERE tenant_id = $1)::int AS "payRuns",
              (SELECT period FROM pay_settings WHERE tenant_id = $1) AS "payPeriod",
              (SELECT count(*) FROM push_devices WHERE tenant_id = $1)::int AS devices`,
      [tenantId],
    );
    const customBranding =
      !!branding &&
      ((branding.primaryColor as string)?.toUpperCase() !== '#2563EB' ||
        !!branding.hasLogo ||
        !!branding.welcomeMessage ||
        !!branding.displayName);
    // Pour chaque avantage : inclus dans la formule, et réellement utilisé.
    const usage: Record<Feature, string | null> = {
      groups: use.groups
        ? `${use.groups} groupe${use.groups > 1 ? 's' : ''}`
        : null,
      manual_approval:
        settings && settings.approvalMode !== 'automatic'
          ? `Validation ${settings.approvalMode === 'manual' ? 'manuelle' : 'mixte'}`
          : null,
      missions: use.missions
        ? `${use.missions} mission${use.missions > 1 ? 's' : ''} active${use.missions > 1 ? 's' : ''}`
        : null,
      branding: customBranding ? 'Apparence personnalisée' : null,
      exports: null,
      stats: null,
      team_leads: use.leads
        ? `${use.leads} chef${use.leads > 1 ? 's' : ''} d’équipe`
        : null,
      audit: null,
      payroll: use.payGrids
        ? `${use.payGrids} grille${use.payGrids > 1 ? 's' : ''}, ${use.payRuns} paie${use.payRuns > 1 ? 's' : ''}`
        : null,
      push_notifications: use.devices
        ? `${use.devices} téléphone${use.devices > 1 ? 's' : ''} joignable${use.devices > 1 ? 's' : ''}`
        : null,
    };
    return {
      settings,
      effective: settings
        ? effectiveSettings(
            Object.assign(settings, { tenantId }),
            summary.features,
          )
        : null,
      features: Object.values(Feature).map((feature) => ({
        feature,
        included: summary.features.includes(feature),
        usage: usage[feature],
      })),
      branding,
      payroll: {
        period: use.payPeriod,
        grids: use.payGrids,
        runs: use.payRuns,
      },
    };
  }

  /** Journal de la structure : connexions et modifications, filtrables. */
  async activity(tenantId: string, query: TenantActivityQuery) {
    await this.assertExists(tenantId);
    const { page, limit } = query;
    const rows = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT l.id, l.action, l.method, l.path, l.status_code AS "statusCode", l.ip,
              l.created_at AS "createdAt",
              CASE WHEN u.id IS NULL THEN NULL ELSE u.first_name || ' ' || u.last_name END AS "userName",
              u.role AS "userRole",
              count(*) OVER()::int AS total
       FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.tenant_id = $1
         AND ($2::text IS NULL
              OR ($2 = 'logins' AND l.action IN ('auth.login', 'auth.login_failed'))
              OR ($2 = 'failed' AND (l.action = 'auth.login_failed' OR l.status_code >= 400))
              OR ($2 = 'changes' AND l.method IS NOT NULL AND l.method <> 'GET'))
       ORDER BY l.created_at DESC
       LIMIT $3 OFFSET $4`,
      [tenantId, query.kind ?? null, limit, (page - 1) * limit],
    );
    const total = (rows[0]?.total as number | undefined) ?? 0;
    return {
      items: rows.map(withoutTotal),
      total,
      page,
      limit,
    };
  }
}
