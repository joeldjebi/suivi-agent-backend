import { AppVersionService } from '../app-version/app-version';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  BillingCycle,
  Feature,
  InvoiceStatus,
  PlanCode,
  Role,
  SubscriptionStatus,
} from '@suivi/shared';
import * as bcrypt from 'bcrypt';
import { hashPassword } from '../auth/auth.service';
import { AuthService } from '../auth/auth.service';
import {
  BusinessException,
  badRequest,
  conflict,
  notFound,
} from '../common/business.exception';
import { DbService } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { normalizePhone } from '../common/phone';
import { SessionRevocationService } from '../common/session-revocation.service';
import {
  Invoice,
  Plan,
  PlatformAdmin,
  PlatformSettings,
  Subscription,
  Tenant,
  User,
} from '../entities';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  AuditQuery,
  CreatePlanDto,
  CreatePlatformAdminDto,
  CreateTenantDto,
  ListInvoicesQuery,
  ListTenantsQuery,
  MfaDisableDto,
  PlatformLoginDto,
  PlatformMfaLoginDto,
  PlatformPasswordDto,
  PlatformSubscriptionDto,
  RecordPaymentDto,
  UpdatePlanDto,
  UpdatePlatformSettingsDto,
  UpdateTenantDto,
} from './platform.dto';
import * as QRCode from 'qrcode';
import { LoginThrottle } from './platform-security';
import { PlatformTenantService } from './platform-tenant.service';
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from './totp';
import {
  PlatformJwtPayload,
  mfaRequired,
  PlatformUser,
  platformSecret,
} from './platform-auth';

const DAY = 86400_000;
/** Session de l'éditeur : une journée de travail, sans renouvellement. */
const SESSION_SECONDS = 10 * 3600;

const invalidMfaCode = () =>
  new BusinessException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_MFA_CODE',
    'Code incorrect ou déjà utilisé',
  );

/** Durée pour saisir le code après le mot de passe. */
const MFA_STEP_SECONDS = 5 * 60;

const invalidCredentials = () =>
  new BusinessException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_CREDENTIALS',
    'Email ou mot de passe incorrect',
  );

/**
 * Revenu mensuel récurrent d'un abonnement (alias s, p, ps) : forfait (ou prix négocié)
 * + agents supplémentaires, remise annuelle déduite. Seuls les clients payants comptent.
 */
const MRR_SQL = `CASE WHEN s.status IN ('active', 'past_due') THEN
    round((coalesce(s.custom_monthly_price, p.monthly_price) + s.extra_agents * p.extra_agent_price)
          * (100 - CASE WHEN s.billing_cycle = 'annual' THEN ps.annual_discount_percent ELSE 0 END) / 100.0)
  ELSE 0 END`;

const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/** Copie sans la clé donnée (mot de passe, total de pagination…). */
function omit<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

/** Espace de l'éditeur : structures, abonnements, factures, catalogue et réglages. */
@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly revocation: SessionRevocationService,
    private readonly subscriptions: SubscriptionsService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
    private readonly throttle: LoginThrottle,
    private readonly tenantData: PlatformTenantService,
    private readonly appVersions: AppVersionService,
  ) {}

  // ------------------------------------------------------------ journal

  private async log(
    admin: PlatformUser | null,
    action: string,
    tenantId: string | null,
    details: Record<string, unknown> = {},
    ip?: string,
  ) {
    await this.db.manager.query(
      `INSERT INTO platform_audit (admin_id, action, tenant_id, details, ip)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        admin?.id ?? null,
        action,
        tenantId,
        JSON.stringify(details),
        ip ?? null,
      ],
    );
  }

  /** Prévient les administrateurs d'une structure, une fois la modification validée. */
  private notifyAdmins(
    tenantId: string,
    input: { type: string; title: string; body?: string },
  ) {
    this.db.afterCommit(() => {
      this.db
        .runAsTenant(tenantId, async () => {
          const admins = await this.db.manager.find(User, {
            select: { id: true },
            where: { role: Role.Admin, isActive: true },
          });
          await this.notifications.notify(
            admins.map((a) => a.id),
            input,
          );
        })
        .catch((error) =>
          this.logger.error('Échec de la notification de la structure', error),
        );
    });
  }

  async audit(query: AuditQuery) {
    const { page, limit, tenantId } = query;
    const rows = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT a.id, a.action, a.tenant_id AS "tenantId", t.name AS "tenantName", a.details, a.ip,
              a.created_at AS "createdAt",
              CASE WHEN pa.id IS NULL THEN NULL ELSE pa.first_name || ' ' || pa.last_name END AS "adminName",
              count(*) OVER()::int AS total
       FROM platform_audit a
       LEFT JOIN platform_admins pa ON pa.id = a.admin_id
       LEFT JOIN tenants t ON t.id = a.tenant_id
       WHERE ($1::uuid IS NULL OR a.tenant_id = $1)
       ORDER BY a.created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId ?? null, limit, (page - 1) * limit],
    );
    return this.paged(rows, page, limit);
  }

  private paged<T extends Record<string, unknown>>(
    rows: T[],
    page: number,
    limit: number,
  ) {
    const total = (rows[0]?.total as number | undefined) ?? 0;
    return {
      items: rows.map((row) => omit(row, 'total')),
      total,
      page,
      limit,
    };
  }

  // ------------------------------------------------------- authentification

  async login(dto: PlatformLoginDto, ip = '') {
    const m = this.db.manager;
    // Verrouillage avant toute vérification : le bon mot de passe ne passe plus non plus.
    await this.throttle.assertAllowed(ip, dto.email);
    const admin = await m
      .createQueryBuilder(PlatformAdmin, 'a')
      .addSelect('a.passwordHash')
      .where('lower(a.email) = lower(:email)', { email: dto.email })
      .getOne();
    const valid =
      !!admin &&
      admin.isActive &&
      (await bcrypt.compare(dto.password, admin.passwordHash));
    if (!valid) {
      // Transaction séparée : celle de la requête est annulée par l'erreur.
      await this.db.runAsSystem(() =>
        this.log(
          admin ? { id: admin.id, email: admin.email } : null,
          'auth.login_failed',
          null,
          { email: dto.email.toLowerCase() },
          ip,
        ),
      );
      await this.throttle.fail(ip, dto.email);
      throw invalidCredentials();
    }
    // Double authentification : le mot de passe seul n'ouvre pas la session.
    if (admin.mfaEnabledAt) {
      const mfaToken = await this.jwt.signAsync(
        { sub: admin.id, scope: 'platform-mfa' },
        { secret: platformSecret(this.config), expiresIn: MFA_STEP_SECONDS },
      );
      return { mfaRequired: true, mfaToken, expiresIn: MFA_STEP_SECONDS };
    }
    await this.throttle.reset(dto.email);
    return this.opened(admin, ip, false);
  }

  /** Connexion réussie : date, journal et session. */
  private async opened(admin: PlatformAdmin, ip: string, mfa: boolean) {
    await this.db.manager.update(
      PlatformAdmin,
      { id: admin.id },
      { lastLoginAt: new Date() },
    );
    await this.log(admin, 'auth.login', null, mfa ? { mfa: true } : {}, ip);
    return this.session(admin);
  }

  /** Deuxième étape : code de l'application d'authentification, ou code de secours. */
  async loginMfa(dto: PlatformMfaLoginDto, ip = '') {
    let sub: string;
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        scope: string;
      }>(dto.mfaToken, { secret: platformSecret(this.config) });
      if (payload.scope !== 'platform-mfa') throw new Error('portée');
      sub = payload.sub;
    } catch {
      throw new BusinessException(
        HttpStatus.UNAUTHORIZED,
        'MFA_SESSION_EXPIRED',
        'Délai dépassé : reconnectez-vous avec votre mot de passe',
      );
    }
    const admin = await this.withMfa(sub);
    if (!admin?.isActive || !admin.mfaEnabledAt) throw invalidCredentials();
    await this.throttle.assertAllowed(ip, admin.email);
    if (!(await this.checkSecondFactor(admin, dto.code))) {
      await this.db.runAsSystem(() =>
        this.log(admin, 'auth.mfa_failed', null, {}, ip),
      );
      await this.throttle.fail(ip, admin.email);
      throw invalidMfaCode();
    }
    await this.throttle.reset(admin.email);
    return this.opened(admin, ip, true);
  }

  /** Compte avec ses données de double authentification (non lues par défaut). */
  private withMfa(id: string) {
    return this.db.manager
      .createQueryBuilder(PlatformAdmin, 'a')
      .addSelect([
        'a.passwordHash',
        'a.mfaSecret',
        'a.mfaRecoveryCodes',
        'a.mfaLastStep',
      ])
      .where('a.id = :id', { id })
      .getOne();
  }

  private mfaKey() {
    return (
      this.config.get<string>('PLATFORM_MFA_KEY') ??
      `${platformSecret(this.config)}::mfa`
    );
  }

  /**
   * Code TOTP (une seule utilisation par période de 30 s) ou code de secours (consommé).
   */
  private async checkSecondFactor(admin: PlatformAdmin, code: string) {
    if (!admin.mfaSecret) return false;
    const step = verifyTotp(
      decryptSecret(admin.mfaSecret, this.mfaKey()),
      code,
    );
    if (step !== null) {
      if (admin.mfaLastStep !== null && step <= Number(admin.mfaLastStep))
        return false;
      await this.db.manager.update(
        PlatformAdmin,
        { id: admin.id },
        { mfaLastStep: String(step) },
      );
      return true;
    }
    const hash = hashRecoveryCode(code);
    if (!admin.mfaRecoveryCodes.includes(hash)) return false;
    await this.db.manager.update(
      PlatformAdmin,
      { id: admin.id },
      { mfaRecoveryCodes: admin.mfaRecoveryCodes.filter((c) => c !== hash) },
    );
    await this.log(admin, 'auth.mfa_recovery_used', null, {
      left: admin.mfaRecoveryCodes.length - 1,
    });
    return true;
  }

  /** Mise en place : nouveau secret en attente, QR code à scanner. */
  async mfaSetup(admin: PlatformUser) {
    const found = await this.withMfa(admin.id);
    if (!found) throw invalidCredentials();
    if (found.mfaEnabledAt)
      throw conflict(
        'MFA_ALREADY_ENABLED',
        'La double authentification est déjà active',
      );
    const secret = generateSecret();
    await this.db.manager.update(
      PlatformAdmin,
      { id: admin.id },
      { mfaSecret: encryptSecret(secret, this.mfaKey()), mfaLastStep: null },
    );
    const url = otpauthUrl(secret, found.email, 'Suivi Agent');
    return {
      secret,
      otpauthUrl: url,
      qrCode: await QRCode.toDataURL(url, { margin: 1, width: 220 }),
    };
  }

  /** Activation après un premier code juste ; codes de secours remis une seule fois. */
  async mfaEnable(admin: PlatformUser, code: string) {
    const found = await this.withMfa(admin.id);
    if (!found?.mfaSecret || found.mfaEnabledAt)
      throw conflict('MFA_NOT_PENDING', 'Lancez d’abord la mise en place');
    if (!(await this.checkSecondFactor(found, code))) throw invalidMfaCode();
    const recoveryCodes = generateRecoveryCodes();
    await this.db.manager.update(
      PlatformAdmin,
      { id: admin.id },
      {
        mfaEnabledAt: new Date(),
        mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode),
      },
    );
    await this.log(admin, 'auth.mfa_enabled', null);
    // Nouvelle session : elle porte la double authentification.
    const session = await this.session({ ...found, mfaEnabledAt: new Date() });
    return { ...session, recoveryCodes };
  }

  /** Nouveaux codes de secours (les anciens ne valent plus). */
  async mfaRecoveryCodes(admin: PlatformUser, code: string) {
    const found = await this.withMfa(admin.id);
    if (!found?.mfaEnabledAt)
      throw conflict('MFA_NOT_ENABLED', 'Double authentification inactive');
    if (!(await this.checkSecondFactor(found, code))) throw invalidMfaCode();
    const recoveryCodes = generateRecoveryCodes();
    await this.db.manager.update(
      PlatformAdmin,
      { id: admin.id },
      { mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode) },
    );
    await this.log(admin, 'auth.mfa_recovery_regenerated', null);
    return { recoveryCodes };
  }

  /** Désactivation : mot de passe et code ; refusée si elle est obligatoire. */
  async mfaDisable(admin: PlatformUser, dto: MfaDisableDto) {
    if (mfaRequired(this.config))
      throw conflict(
        'MFA_REQUIRED',
        'La double authentification est obligatoire sur cette plateforme',
      );
    const found = await this.withMfa(admin.id);
    if (!found?.mfaEnabledAt)
      throw conflict('MFA_NOT_ENABLED', 'Double authentification inactive');
    if (!(await bcrypt.compare(dto.password, found.passwordHash)))
      throw badRequest('INVALID_PASSWORD', 'Mot de passe incorrect');
    if (!(await this.checkSecondFactor(found, dto.code)))
      throw invalidMfaCode();
    await this.clearMfa(admin.id);
    await this.log(admin, 'auth.mfa_disabled', null);
    return this.session({ ...found, mfaEnabledAt: null });
  }

  private clearMfa(id: string) {
    return this.db.manager.update(
      PlatformAdmin,
      { id },
      {
        mfaSecret: null,
        mfaEnabledAt: null,
        mfaRecoveryCodes: [],
        mfaLastStep: null,
      },
    );
  }

  /** Téléphone perdu : un autre compte éditeur réinitialise la 2FA ; ses sessions sont coupées. */
  async resetAdminMfa(admin: PlatformUser, id: string) {
    if (id === admin.id)
      throw conflict(
        'CANNOT_RESET_SELF',
        'Un autre compte éditeur doit réinitialiser votre double authentification',
      );
    const target = await this.db.manager.findOneBy(PlatformAdmin, { id });
    if (!target) throw notFound('Compte');
    await this.clearMfa(id);
    await this.revocation.revoke(id);
    await this.log(admin, 'admin.mfa_reset', null, { email: target.email });
    return { ...target, mfaEnabledAt: null };
  }

  private async session(admin: PlatformAdmin) {
    const mfa = !!admin.mfaEnabledAt;
    const payload: PlatformJwtPayload = {
      sub: admin.id,
      email: admin.email,
      scope: 'platform',
      mfa,
      iam: Date.now(),
    };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: platformSecret(this.config),
      expiresIn: SESSION_SECONDS,
    });
    const safe = omit(
      omit(omit(omit(admin, 'passwordHash'), 'mfaSecret'), 'mfaRecoveryCodes'),
      'mfaLastStep',
    );
    return {
      accessToken,
      expiresIn: SESSION_SECONDS,
      admin: safe,
      /** Compte à équiper avant d'accéder à la console (2FA obligatoire). */
      mfaSetupRequired: mfaRequired(this.config) && !mfa,
    };
  }

  async me(admin: PlatformUser) {
    const found = await this.db.manager.findOneBy(PlatformAdmin, {
      id: admin.id,
    });
    if (!found?.isActive) throw invalidCredentials();
    return {
      ...found,
      mfaEnabled: !!found.mfaEnabledAt,
      mfaSetupRequired: mfaRequired(this.config) && !admin.mfa,
    };
  }

  async logout(admin: PlatformUser) {
    await this.revocation.revoke(admin.id);
  }

  /** Nouveau mot de passe : les autres sessions sont coupées, celle-ci reçoit un nouveau jeton. */
  async changePassword(admin: PlatformUser, dto: PlatformPasswordDto) {
    const m = this.db.manager;
    const found = await m
      .createQueryBuilder(PlatformAdmin, 'a')
      .addSelect('a.passwordHash')
      .where('a.id = :id', { id: admin.id })
      .getOneOrFail();
    if (!(await bcrypt.compare(dto.currentPassword, found.passwordHash))) {
      throw badRequest('INVALID_PASSWORD', 'Mot de passe actuel incorrect');
    }
    await m.update(
      PlatformAdmin,
      { id: admin.id },
      { passwordHash: await hashPassword(dto.newPassword) },
    );
    await this.revocation.revoke(admin.id);
    await this.log(admin, 'auth.password', null);
    return this.session(found);
  }

  async admins() {
    return this.db.manager.find(PlatformAdmin, {
      order: { createdAt: 'ASC' },
    });
  }

  async createAdmin(admin: PlatformUser, dto: CreatePlatformAdminDto) {
    const m = this.db.manager;
    const [taken] = await m.query<unknown[]>(
      `SELECT 1 FROM platform_admins WHERE lower(email) = lower($1)`,
      [dto.email],
    );
    if (taken) throw conflict('EMAIL_TAKEN', 'Cet email est déjà utilisé');
    const created = await m.save(PlatformAdmin, {
      email: dto.email.toLowerCase(),
      passwordHash: await hashPassword(dto.password),
      firstName: dto.firstName,
      lastName: dto.lastName,
      isActive: true,
    });
    await this.log(admin, 'admin.create', null, { email: created.email });
    return omit(created, 'passwordHash');
  }

  async updateAdmin(admin: PlatformUser, id: string, isActive: boolean) {
    const m = this.db.manager;
    const target = await m.findOneBy(PlatformAdmin, { id });
    if (!target) throw notFound('Compte');
    if (id === admin.id && !isActive)
      throw conflict(
        'CANNOT_DISABLE_SELF',
        'Vous ne pouvez pas désactiver votre propre compte',
      );
    await m.update(PlatformAdmin, { id }, { isActive });
    if (!isActive) await this.revocation.revoke(id);
    await this.log(admin, isActive ? 'admin.enable' : 'admin.disable', null, {
      email: target.email,
    });
    return { ...target, isActive };
  }

  // -------------------------------------------------------- tableau de bord

  async dashboard() {
    const m = this.db.manager;
    const platform = await m.findOneByOrFail(PlatformSettings, { id: 1 });
    const now = new Date();
    const thisMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const lastMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );

    const [tenants] = await m.query<Record<string, number>[]>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE s.status = 'trialing')::int AS trialing,
              count(*) FILTER (WHERE s.status = 'active')::int AS active,
              count(*) FILTER (WHERE s.status = 'past_due')::int AS "pastDue",
              count(*) FILTER (WHERE s.status = 'suspended')::int AS suspended,
              count(*) FILTER (WHERE t.created_at >= $1)::int AS "newThisMonth",
              count(*) FILTER (WHERE t.created_at >= $2 AND t.created_at < $1)::int AS "newLastMonth"
       FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id`,
      [thisMonth, lastMonth],
    );

    const byPlan = await m.query<
      {
        planCode: PlanCode;
        name: string;
        tenants: number;
        paying: number;
        mrr: number;
      }[]
    >(
      `SELECT p.code AS "planCode", p.name,
              count(s.tenant_id)::int AS tenants,
              count(s.tenant_id) FILTER (WHERE s.status IN ('active', 'past_due'))::int AS paying,
              coalesce(sum(${MRR_SQL}), 0)::int AS mrr
       FROM plans p
       CROSS JOIN platform_settings ps
       LEFT JOIN subscriptions s ON s.plan_code = p.code
       GROUP BY p.code, p.name, p.sort ORDER BY p.sort`,
    );
    const mrr = byPlan.reduce((sum, p) => sum + p.mrr, 0);

    const [invoices] = await m.query<Record<string, number>[]>(
      `SELECT coalesce(sum(amount) FILTER (WHERE status = 'pending'), 0)::int AS "pendingAmount",
              count(*) FILTER (WHERE status = 'pending')::int AS "pendingCount",
              coalesce(sum(amount) FILTER (WHERE status = 'pending' AND due_at < now()), 0)::int AS "overdueAmount",
              count(*) FILTER (WHERE status = 'pending' AND due_at < now())::int AS "overdueCount",
              coalesce(sum(amount) FILTER (WHERE status = 'paid' AND paid_at >= $1), 0)::int AS "paidThisMonth",
              coalesce(sum(amount) FILTER (WHERE status = 'paid' AND paid_at >= $2 AND paid_at < $1), 0)::int AS "paidLastMonth"
       FROM invoices`,
      [thisMonth, lastMonth],
    );

    // Douze derniers mois : facturé (mois de la facture), encaissé (mois du paiement), inscriptions.
    const months = await m.query<
      { month: string; invoiced: number; paid: number; signups: number }[]
    >(
      `SELECT to_char(g.month, 'YYYY-MM') AS month,
              coalesce((SELECT sum(amount) FROM invoices i WHERE i.month = g.month::date AND i.status <> 'void'), 0)::int AS invoiced,
              coalesce((SELECT sum(amount) FROM invoices i WHERE i.status = 'paid'
                          AND date_trunc('month', i.paid_at) = g.month), 0)::int AS paid,
              (SELECT count(*) FROM tenants t WHERE date_trunc('month', t.created_at) = g.month)::int AS signups
       FROM generate_series(date_trunc('month', now()) - interval '11 months',
                            date_trunc('month', now()), interval '1 month') AS g(month)
       ORDER BY g.month`,
    );

    const [usage] = await m.query<Record<string, number>[]>(
      `SELECT (SELECT count(*) FROM users WHERE role = 'agent' AND is_active)::int AS agents,
              (SELECT count(*) FROM users WHERE role = 'team_lead' AND is_active)::int AS leads,
              (SELECT count(DISTINCT tenant_id) FROM work_days
                 WHERE work_date >= current_date - 7)::int AS "activeTenants",
              (SELECT count(*) FROM work_days WHERE work_date >= current_date - 30)::int AS "daysLast30"`,
    );

    const trialsEnding = await m.query<Record<string, unknown>[]>(
      `SELECT t.id, t.name, s.trial_ends_at AS "trialEndsAt",
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.role = 'agent' AND u.is_active)::int AS agents
       FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.status = 'trialing' AND s.trial_ends_at < now() + interval '7 days'
       ORDER BY s.trial_ends_at LIMIT 10`,
    );
    const overdueTenants = await m.query<Record<string, unknown>[]>(
      `SELECT t.id, t.name, s.status, count(i.id)::int AS invoices,
              sum(i.amount)::int AS amount, min(i.due_at) AS "oldestDueAt"
       FROM invoices i JOIN tenants t ON t.id = i.tenant_id
       JOIN subscriptions s ON s.tenant_id = t.id
       WHERE i.status = 'pending' AND i.due_at < now()
       GROUP BY t.id, t.name, s.status
       ORDER BY amount DESC LIMIT 10`,
    );
    const recentTenants = await m.query<Record<string, unknown>[]>(
      `SELECT t.id, t.name, t.created_at AS "createdAt", s.status, s.plan_code AS "planCode"
       FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id
       ORDER BY t.created_at DESC LIMIT 5`,
    );

    return {
      currency: platform.currency,
      tenants,
      mrr,
      arr: mrr * 12,
      byPlan,
      invoices,
      months,
      usage,
      trialsEnding,
      overdueTenants,
      recentTenants,
      generatedAt: now,
      currentMonth: monthKey(thisMonth),
    };
  }

  // ------------------------------------------------------------ structures

  async tenants(query: ListTenantsQuery) {
    const { page, limit } = query;
    const order = {
      name: 'lower(t.name)',
      created: 't."createdAt" DESC',
      agents: 't.agents DESC, lower(t.name)',
      mrr: 't.mrr DESC, lower(t.name)',
      activity: 't."lastActivity" DESC NULLS LAST, lower(t.name)',
    }[query.sort ?? 'created'];
    const rows = await this.db.manager.query<Record<string, unknown>[]>(
      `WITH list AS (
         SELECT t.id, t.name, t.created_at AS "createdAt", t.contact_phone AS "contactPhone",
                s.status, s.plan_code AS "planCode", p.name AS "planName", s.billing_cycle AS "billingCycle",
                s.trial_ends_at AS "trialEndsAt", s.manual_suspension AS "manualSuspension",
                (s.custom_monthly_price IS NOT NULL OR s.custom_included_agents IS NOT NULL
                   OR s.custom_included_leads IS NOT NULL) AS "customTerms",
                coalesce(${MRR_SQL}, 0)::int AS mrr,
                a.email AS "adminEmail", a.first_name || ' ' || a.last_name AS "adminName", a.phone AS "adminPhone",
                (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.role = 'agent' AND u.is_active)::int AS agents,
                (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.role = 'team_lead' AND u.is_active)::int AS leads,
                -- Pendant l'essai : quotas de la formule Entreprise (sauf conditions négociées).
                coalesce(s.custom_included_agents,
                         CASE WHEN s.status = 'trialing'
                              THEN (SELECT included_agents FROM plans WHERE code = ps.trial_plan_code)
                              ELSE p.included_agents END)
                  + coalesce(s.extra_agents, 0) AS "agentLimit",
                (SELECT max(d.started_at) FROM work_days d WHERE d.tenant_id = t.id) AS "lastActivity",
                (SELECT coalesce(sum(i.amount), 0) FROM invoices i
                   WHERE i.tenant_id = t.id AND i.status = 'pending' AND i.due_at < now())::int AS "overdueAmount"
         FROM tenants t
         LEFT JOIN subscriptions s ON s.tenant_id = t.id
         LEFT JOIN plans p ON p.code = s.plan_code
         CROSS JOIN platform_settings ps
         LEFT JOIN LATERAL (
           SELECT email, first_name, last_name, phone FROM users
           WHERE tenant_id = t.id AND role = 'admin' ORDER BY created_at LIMIT 1
         ) a ON true
       )
       SELECT *, count(*) OVER()::int AS total FROM list t
       WHERE ($1::text IS NULL OR t.name ILIKE '%' || $1 || '%' OR t."adminEmail" ILIKE '%' || $1 || '%'
              OR t."adminPhone" LIKE '%' || $2 || '%' OR t."contactPhone" LIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR t.status = $3)
         AND ($4::text IS NULL OR t."planCode" = $4)
         AND (NOT $5 OR t."overdueAmount" > 0)
       ORDER BY ${order}
       LIMIT $6 OFFSET $7`,
      [
        query.search?.trim() || null,
        // Recherche par numéro : chiffres seulement (07 07… comme +225 07…).
        query.search ? query.search.replace(/\D/g, '').slice(-8) || '§' : '§',
        query.status ?? null,
        query.planCode ?? null,
        query.overdue ?? false,
        limit,
        (page - 1) * limit,
      ],
    );
    return this.paged(rows, page, limit);
  }

  private async tenantOrFail(id: string): Promise<Tenant> {
    const tenant = await this.db.manager.findOneBy(Tenant, { id });
    if (!tenant) throw notFound('Structure');
    return tenant;
  }

  async tenant(id: string) {
    const m = this.db.manager;
    const tenant = await this.tenantOrFail(id);
    const platform = await m.findOneByOrFail(PlatformSettings, { id: 1 });
    const sub = await m.findOneBy(Subscription, { tenantId: id });
    const plans = await m.find(Plan, { order: { sort: 'ASC' } });
    const plan = sub ? plans.find((p) => p.code === sub.planCode)! : null;
    // Comptes et quotas lus dans le périmètre de la structure.
    const usage = sub
      ? await this.db.runAsTenant(id, () =>
          this.subscriptions.usage(sub, plans),
        )
      : null;
    const now = new Date();
    const estimate =
      sub && plan
        ? this.subscriptions.estimate(
            sub,
            plan,
            platform,
            new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
          )
        : null;

    const admins = await m.query<Record<string, unknown>[]>(
      `SELECT id, first_name AS "firstName", last_name AS "lastName", email, phone, is_active AS "isActive",
              created_at AS "createdAt",
              (SELECT max(l.created_at) FROM audit_logs l WHERE l.user_id = u.id AND l.action = 'auth.login') AS "lastLoginAt"
       FROM users u WHERE u.tenant_id = $1 AND u.role = 'admin' ORDER BY created_at`,
      [id],
    );
    const [counts] = await m.query<Record<string, number>[]>(
      `SELECT (SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'agent')::int AS agents,
              (SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'agent' AND is_active)::int AS "activeAgents",
              (SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'team_lead' AND is_active)::int AS leads,
              (SELECT count(*) FROM zones WHERE tenant_id = $1)::int AS zones,
              (SELECT count(*) FROM groups WHERE tenant_id = $1)::int AS groups,
              (SELECT count(*) FROM missions WHERE tenant_id = $1)::int AS missions,
              (SELECT count(*) FROM work_days WHERE tenant_id = $1 AND work_date >= current_date - 30)::int AS "daysLast30",
              (SELECT max(started_at) FROM work_days WHERE tenant_id = $1) AS "lastActivity"`,
      [id],
    );
    // Activité des 30 derniers jours : journées démarrées et agents présents.
    const activity = await m.query<{ date: string; days: number }[]>(
      `SELECT to_char(g.day, 'YYYY-MM-DD') AS date,
              (SELECT count(*) FROM work_days d WHERE d.tenant_id = $1 AND d.work_date = g.day::date)::int AS days
       FROM generate_series(current_date - 29, current_date, interval '1 day') AS g(day)
       ORDER BY g.day`,
      [id],
    );
    const invoices = await m.find(Invoice, {
      where: { tenantId: id },
      order: { month: 'DESC' },
    });
    const history = await m.query<Record<string, unknown>[]>(
      `SELECT a.id, a.action, a.details, a.created_at AS "createdAt",
              pa.first_name || ' ' || pa.last_name AS "adminName"
       FROM platform_audit a LEFT JOIN platform_admins pa ON pa.id = a.admin_id
       WHERE a.tenant_id = $1 ORDER BY a.created_at DESC LIMIT 30`,
      [id],
    );

    const alerts = await this.tenantData.alerts(id, {
      subscription: sub,
      usage,
      invoices,
      lastActivity: counts.lastActivity as unknown as string | null,
      activeAgents: counts.activeAgents,
    });
    return {
      tenant,
      alerts,
      subscription: sub,
      plan,
      plans,
      currency: platform.currency,
      usage,
      estimate,
      admins,
      counts,
      activity,
      invoices,
      history,
    };
  }

  async createTenant(admin: PlatformUser, dto: CreateTenantDto) {
    const m = this.db.manager;
    if (dto.planCode && !(await m.findOneBy(Plan, { code: dto.planCode })))
      throw conflict('PLAN_UNAVAILABLE', 'Cette formule n’existe pas');
    const user = await this.auth.createTenant({
      ...dto,
      contactPhone: dto.contactPhone
        ? (normalizePhone(dto.contactPhone) ?? dto.contactPhone)
        : null,
    });
    const tenantId = user.tenantId;
    // Cliente directement : formule choisie, pas d'essai.
    if (dto.planCode) {
      const cycle = dto.billingCycle ?? BillingCycle.Monthly;
      await m.update(
        Subscription,
        { tenantId },
        {
          planCode: dto.planCode,
          billingCycle: cycle,
          status: SubscriptionStatus.Active,
          trialEndsAt: null,
          commitmentEndsAt:
            cycle === BillingCycle.Annual
              ? new Date(Date.now() + 365 * DAY)
              : null,
        },
      );
    }
    await this.log(admin, 'tenant.create', tenantId, {
      name: dto.organizationName,
      adminEmail: dto.email.toLowerCase(),
      planCode: dto.planCode ?? null,
    });
    return this.tenant(tenantId);
  }

  async updateTenant(admin: PlatformUser, id: string, dto: UpdateTenantDto) {
    const tenant = await this.tenantOrFail(id);
    const changes: Partial<Tenant> = {};
    if (dto.name !== undefined) changes.name = dto.name.trim();
    if (dto.notes !== undefined) changes.notes = dto.notes.trim() || null;
    if (dto.contactPhone !== undefined)
      changes.contactPhone = dto.contactPhone.trim()
        ? (normalizePhone(dto.contactPhone) ?? dto.contactPhone.trim())
        : null;
    if (Object.keys(changes).length)
      await this.db.manager.update(Tenant, { id }, changes);
    await this.log(admin, 'tenant.update', id, {
      fields: Object.keys(changes),
      ...(changes.name && changes.name !== tenant.name
        ? { from: tenant.name, to: changes.name }
        : {}),
    });
    return { ...tenant, ...changes };
  }

  private async subscriptionOrFail(tenantId: string): Promise<Subscription> {
    await this.tenantOrFail(tenantId);
    const sub = await this.db.manager.findOneBy(Subscription, { tenantId });
    if (!sub) throw notFound('Abonnement');
    return sub;
  }

  /**
   * Abonnement modifié par l'éditeur. Les dépassements de quotas ne bloquent pas :
   * ils sont renvoyés dans `warnings` (la structure ne pourra plus ajouter de comptes).
   */
  async updateSubscription(
    admin: PlatformUser,
    tenantId: string,
    dto: PlatformSubscriptionDto,
  ) {
    const m = this.db.manager;
    const sub = await this.subscriptionOrFail(tenantId);
    if (dto.planCode && !(await m.findOneBy(Plan, { code: dto.planCode })))
      throw conflict('PLAN_UNAVAILABLE', 'Cette formule n’existe pas');

    const changes: Partial<Subscription> = {};
    if (dto.planCode !== undefined) changes.planCode = dto.planCode;
    if (dto.extraAgents !== undefined) changes.extraAgents = dto.extraAgents;
    for (const key of [
      'customMonthlyPrice',
      'customIncludedAgents',
      'customIncludedLeads',
    ] as const) {
      if (dto[key] !== undefined) changes[key] = dto[key];
    }
    if (
      dto.billingCycle !== undefined &&
      dto.billingCycle !== sub.billingCycle
    ) {
      changes.billingCycle = dto.billingCycle;
      changes.commitmentEndsAt =
        dto.billingCycle === BillingCycle.Annual
          ? new Date(Date.now() + 365 * DAY)
          : null;
    }
    if (dto.trialEndsAt !== undefined) {
      if (sub.status !== SubscriptionStatus.Trialing)
        throw conflict(
          'NOT_IN_TRIAL',
          'La structure n’est plus en essai gratuit',
        );
      const end = new Date(dto.trialEndsAt);
      if (end.getTime() < Date.now())
        throw badRequest(
          'TRIAL_END_IN_PAST',
          'La fin de l’essai doit être dans le futur',
        );
      changes.trialEndsAt = end;
    }
    if (Object.keys(changes).length)
      await m.update(Subscription, { tenantId }, changes);
    this.db.afterCommit(() => this.subscriptions.invalidate(tenantId));

    const after = { ...sub, ...changes };
    // Toutes les formules, y compris celles qui ne sont plus proposées.
    const plans = await m.find(Plan);
    const usage = await this.db.runAsTenant(tenantId, () =>
      this.subscriptions.usage(after, plans),
    );
    const warnings: string[] = [];
    if (usage.agents.used > usage.agents.limit)
      warnings.push(
        `${usage.agents.used} agents actifs pour ${usage.agents.limit} autorisés`,
      );
    if (usage.leads.used > usage.leads.limit)
      warnings.push(
        `${usage.leads.used} chefs d’équipe actifs pour ${usage.leads.limit} autorisés`,
      );
    await this.log(admin, 'subscription.update', tenantId, {
      before: Object.fromEntries(
        Object.keys(changes).map((k) => [k, sub[k as keyof Subscription]]),
      ),
      after: changes,
    });
    return { subscription: after, usage, warnings };
  }

  /** Suspension décidée par l'éditeur : l'accès est coupé jusqu'à la réactivation. */
  async suspend(admin: PlatformUser, tenantId: string, reason: string) {
    const sub = await this.subscriptionOrFail(tenantId);
    if (sub.status === SubscriptionStatus.Suspended && sub.manualSuspension)
      throw conflict('ALREADY_SUSPENDED', 'La structure est déjà suspendue');
    await this.db.manager.update(
      Subscription,
      { tenantId },
      {
        status: SubscriptionStatus.Suspended,
        manualSuspension: true,
        suspensionReason: reason,
        suspendedAt: new Date(),
      },
    );
    this.db.afterCommit(() => this.subscriptions.invalidate(tenantId));
    await this.log(admin, 'tenant.suspend', tenantId, { reason });
    this.notifyAdmins(tenantId, {
      type: 'subscription.suspended',
      title: 'Abonnement suspendu',
      body: reason,
    });
    return this.db.manager.findOneByOrFail(Subscription, { tenantId });
  }

  /**
   * Réactivation : essai en cours, sinon actif. Les factures échues s'appliquent ensuite
   * normalement (retard, puis suspension après le délai de grâce).
   */
  async reactivate(admin: PlatformUser, tenantId: string) {
    const m = this.db.manager;
    const sub = await this.subscriptionOrFail(tenantId);
    if (sub.status !== SubscriptionStatus.Suspended)
      throw conflict('NOT_SUSPENDED', 'La structure n’est pas suspendue');
    const trialing = !!sub.trialEndsAt && sub.trialEndsAt > new Date();
    await m.update(
      Subscription,
      { tenantId },
      {
        status: trialing
          ? SubscriptionStatus.Trialing
          : SubscriptionStatus.Active,
        manualSuspension: false,
        suspensionReason: null,
        suspendedAt: null,
      },
    );
    await this.subscriptions.syncStatus(tenantId);
    this.db.afterCommit(() => this.subscriptions.invalidate(tenantId));
    const after = await m.findOneByOrFail(Subscription, { tenantId });
    await this.log(admin, 'tenant.reactivate', tenantId, {
      status: after.status,
    });
    if (after.status !== SubscriptionStatus.Suspended)
      this.notifyAdmins(tenantId, {
        type: 'subscription.reactivated',
        title: 'Abonnement réactivé',
        body: 'L’accès à la plateforme est rétabli.',
      });
    return after;
  }

  // -------------------------------------------------------------- factures

  async invoices(query: ListInvoicesQuery) {
    const { page, limit } = query;
    const rows = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT i.id, i.number, to_char(i.month, 'YYYY-MM') AS month, i.plan_code AS "planCode",
              i.billing_cycle AS "billingCycle", i.agents, i.base_price AS "basePrice",
              i.extra_agents AS "extraAgents", i.extra_agent_price AS "extraAgentPrice",
              i.prorata_percent AS "prorataPercent", i.discount_percent AS "discountPercent",
              i.amount, i.currency, i.status, i.issued_at AS "issuedAt", i.due_at AS "dueAt",
              i.paid_at AS "paidAt", i.payment_reference AS "paymentReference",
              i.payment_method AS "paymentMethod", i.recorded_by AS "recordedBy", i.void_reason AS "voidReason",
              (i.status = 'pending' AND i.due_at < now()) AS overdue,
              i.tenant_id AS "tenantId", t.name AS "tenantName",
              count(*) OVER()::int AS total,
              sum(i.amount) OVER()::int AS "totalAmount"
       FROM invoices i JOIN tenants t ON t.id = i.tenant_id
       WHERE ($1::text IS NULL OR i.status = $1)
         AND ($2::uuid IS NULL OR i.tenant_id = $2)
         AND ($3::text IS NULL OR to_char(i.month, 'YYYY-MM') = $3)
         AND (NOT $4 OR (i.status = 'pending' AND i.due_at < now()))
         AND ($5::text IS NULL OR i.number ILIKE '%' || $5 || '%' OR t.name ILIKE '%' || $5 || '%')
       ORDER BY i.month DESC, t.name
       LIMIT $6 OFFSET $7`,
      [
        query.status ?? null,
        query.tenantId ?? null,
        query.month ?? null,
        query.overdue ?? false,
        query.search?.trim() || null,
        limit,
        (page - 1) * limit,
      ],
    );
    const totalAmount = (rows[0]?.totalAmount as number | undefined) ?? 0;
    const result = this.paged(
      rows.map((row) => omit(row, 'totalAmount')),
      page,
      limit,
    );
    return { ...result, totalAmount };
  }

  private async pendingInvoice(id: string): Promise<Invoice> {
    const invoice = await this.db.manager.findOneBy(Invoice, { id });
    if (!invoice) throw notFound('Facture');
    if (invoice.status !== InvoiceStatus.Pending)
      throw conflict(
        'INVOICE_NOT_PENDING',
        invoice.status === InvoiceStatus.Paid
          ? 'Cette facture est déjà payée'
          : 'Cette facture est annulée',
      );
    return invoice;
  }

  /**
   * Paiement reçu hors plateforme (Mobile Money, virement, espèces). La structure
   * redevient active dès qu'il ne reste plus de facture échue.
   */
  async recordPayment(admin: PlatformUser, id: string, dto: RecordPaymentDto) {
    const m = this.db.manager;
    const invoice = await this.pendingInvoice(id);
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    if (paidAt.getTime() > Date.now() + 60_000)
      throw badRequest(
        'PAID_AT_IN_FUTURE',
        'La date de paiement ne peut pas être dans le futur',
      );
    await m.update(
      Invoice,
      { id },
      {
        status: InvoiceStatus.Paid,
        paidAt,
        paymentMethod: dto.method,
        paymentReference: dto.reference?.trim() || null,
        recordedBy: admin.email,
      },
    );
    await this.subscriptions.syncStatus(invoice.tenantId);
    this.db.afterCommit(() => this.subscriptions.invalidate(invoice.tenantId));
    await this.log(admin, 'invoice.paid', invoice.tenantId, {
      number: invoice.number,
      amount: invoice.amount,
      method: dto.method,
      reference: dto.reference ?? null,
    });
    this.notifyAdmins(invoice.tenantId, {
      type: 'invoice.paid',
      title: 'Paiement reçu',
      body: `Facture ${invoice.number} : ${invoice.amount.toLocaleString('fr-FR')} ${invoice.currency}. Merci !`,
    });
    return {
      invoice: await m.findOneByOrFail(Invoice, { id }),
      subscription: await m.findOneBy(Subscription, {
        tenantId: invoice.tenantId,
      }),
    };
  }

  /** Facture annulée (erreur, geste commercial) : elle ne compte plus dans les impayés. */
  async voidInvoice(admin: PlatformUser, id: string, reason: string) {
    const m = this.db.manager;
    const invoice = await this.pendingInvoice(id);
    await m.update(
      Invoice,
      { id },
      {
        status: InvoiceStatus.Void,
        voidReason: reason,
        recordedBy: admin.email,
      },
    );
    await this.subscriptions.syncStatus(invoice.tenantId);
    this.db.afterCommit(() => this.subscriptions.invalidate(invoice.tenantId));
    await this.log(admin, 'invoice.void', invoice.tenantId, {
      number: invoice.number,
      amount: invoice.amount,
      reason,
    });
    return {
      invoice: await m.findOneByOrFail(Invoice, { id }),
      subscription: await m.findOneBy(Subscription, {
        tenantId: invoice.tenantId,
      }),
    };
  }

  // -------------------------------------------------- catalogue et réglages

  async plans() {
    return this.db.manager.query<Record<string, unknown>[]>(
      `SELECT p.code, p.name, p.description, p.monthly_price AS "monthlyPrice",
              p.included_agents AS "includedAgents", p.included_leads AS "includedLeads",
              p.extra_agent_price AS "extraAgentPrice", p.sort, p.is_active AS "isActive",
              p.features, p.updated_at AS "updatedAt",
              (SELECT count(*) FROM subscriptions s WHERE s.plan_code = p.code)::int AS tenants,
              (SELECT count(*) FROM subscriptions s
                 WHERE s.plan_code = p.code AND s.status IN ('active', 'past_due'))::int AS paying,
              (p.code = ps.trial_plan_code) AS "isTrialPlan",
              (p.code = ps.default_plan_code) AS "isDefaultPlan"
       FROM plans p CROSS JOIN platform_settings ps
       ORDER BY p.sort, p.monthly_price`,
    );
  }

  private async planOrFail(code: string): Promise<Plan> {
    const plan = await this.db.manager.findOneBy(Plan, { code });
    if (!plan) throw notFound('Formule');
    return plan;
  }

  /** Nouvelle formule : proposée aux structures dès sa création (sauf si retirée). */
  async createPlan(admin: PlatformUser, dto: CreatePlanDto) {
    const m = this.db.manager;
    if (await m.findOneBy(Plan, { code: dto.code }))
      throw conflict('PLAN_CODE_TAKEN', 'Ce code de formule existe déjà');
    const [{ next }] = await m.query<{ next: number }[]>(
      `SELECT coalesce(max(sort), 0) + 1 AS next FROM plans`,
    );
    await m.insert(Plan, {
      code: dto.code,
      name: dto.name.trim(),
      description: dto.description.trim(),
      monthlyPrice: dto.monthlyPrice,
      includedAgents: dto.includedAgents,
      includedLeads: dto.includedLeads,
      extraAgentPrice: dto.extraAgentPrice,
      features: dto.features,
      sort: dto.sort ?? next,
      isActive: dto.isActive ?? true,
    });
    this.db.afterCommit(() => {
      this.subscriptions.invalidateAll();
      this.appVersions.invalidate();
    });
    await this.log(admin, 'plan.create', null, {
      code: dto.code,
      name: dto.name,
      features: dto.features,
    });
    return this.planOrFail(dto.code);
  }

  /**
   * Formule modifiée : prix et quotas pour les prochaines factures (les factures émises gardent
   * leurs montants) ; quotas et avantages appliqués immédiatement à toutes ses structures.
   * Les avantages retirés sont signalés avec les structures qui s'en servent.
   */
  async updatePlan(admin: PlatformUser, code: string, dto: UpdatePlanDto) {
    const m = this.db.manager;
    const plan = await this.planOrFail(code);
    if (dto.isActive === false && plan.isActive) {
      const settings = await this.settings();
      if ([settings.trialPlanCode, settings.defaultPlanCode].includes(code))
        throw conflict(
          'PLAN_USED_BY_SETTINGS',
          'Cette formule sert à l’essai ou aux nouvelles structures : changez d’abord les réglages',
        );
      const [{ active }] = await m.query<{ active: number }[]>(
        `SELECT count(*)::int AS active FROM plans WHERE is_active AND code <> $1`,
        [code],
      );
      if (!active)
        throw conflict(
          'LAST_ACTIVE_PLAN',
          'Au moins une formule doit rester proposée',
        );
    }
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    ) as Partial<Plan>;
    if (changes.name) changes.name = changes.name.trim();
    if (Object.keys(changes).length) await m.update(Plan, { code }, changes);
    this.db.afterCommit(() => this.subscriptions.invalidateAll());

    const removed = dto.features
      ? plan.features.filter((f) => !dto.features!.includes(f))
      : [];
    const added = dto.features
      ? dto.features.filter((f) => !plan.features.includes(f))
      : [];
    const impact = await this.featureImpact(code, removed);
    await this.log(admin, 'plan.update', null, {
      code,
      before: Object.fromEntries(
        Object.keys(changes).map((k) => [k, plan[k as keyof Plan]]),
      ),
      after: changes,
    });
    return {
      plan: await this.planOrFail(code),
      added,
      removed,
      ...impact,
    };
  }

  /**
   * Structures touchées par le retrait d'avantages (hors essai, qui a tout) et réglages
   * qu'elles utilisent encore.
   */
  private async featureImpact(code: string, removed: Feature[]) {
    if (!removed.length)
      return { affectedTenants: 0, warnings: [] as string[] };
    const [row] = await this.db.manager.query<
      { affected: number; groups: number; approval: number }[]
    >(
      `SELECT count(*)::int AS affected,
              count(*) FILTER (WHERE ts.use_groups)::int AS groups,
              count(*) FILTER (WHERE ts.approval_mode <> 'automatic')::int AS approval
       FROM subscriptions s JOIN tenant_settings ts ON ts.tenant_id = s.tenant_id
       WHERE s.plan_code = $1 AND s.status <> 'trialing'`,
      [code],
    );
    const warnings: string[] = [];
    if (row.affected)
      warnings.push(
        `${row.affected} structure${row.affected > 1 ? 's perdent' : ' perd'} immédiatement l’accès aux avantages retirés`,
      );
    if (removed.includes(Feature.Groups) && row.groups)
      warnings.push(
        `${row.groups} structure${row.groups > 1 ? 's utilisent' : ' utilise'} les groupes : leurs pages Groupes et Chefs d’équipe se ferment`,
      );
    if (removed.includes(Feature.ManualApproval) && row.approval)
      warnings.push(
        `${row.approval} structure${row.approval > 1 ? 's valident' : ' valide'} les zones manuellement`,
      );
    return { affectedTenants: row.affected, warnings };
  }

  /** Suppression : seulement une formule qu'aucune structure n'a jamais eue en cours. */
  async deletePlan(admin: PlatformUser, code: string) {
    const m = this.db.manager;
    const plan = await this.planOrFail(code);
    const settings = await this.settings();
    if ([settings.trialPlanCode, settings.defaultPlanCode].includes(code))
      throw conflict(
        'PLAN_USED_BY_SETTINGS',
        'Cette formule sert à l’essai ou aux nouvelles structures : changez d’abord les réglages',
      );
    const [{ used }] = await m.query<{ used: number }[]>(
      `SELECT count(*)::int AS used FROM subscriptions WHERE plan_code = $1`,
      [code],
    );
    if (used)
      throw conflict(
        'PLAN_IN_USE',
        `${used} structure${used > 1 ? 's ont' : ' a'} cette formule : retirez-la du catalogue plutôt que de la supprimer`,
      );
    await m.delete(Plan, { code });
    this.db.afterCommit(() => this.subscriptions.invalidateAll());
    await this.log(admin, 'plan.delete', null, { code, name: plan.name });
  }

  async settings() {
    return this.db.manager.findOneByOrFail(PlatformSettings, { id: 1 });
  }

  async updateSettings(admin: PlatformUser, dto: UpdatePlatformSettingsDto) {
    const before = await this.settings();
    for (const code of [dto.trialPlanCode, dto.defaultPlanCode]) {
      if (code === undefined) continue;
      const plan = await this.planOrFail(code);
      if (!plan.isActive)
        throw conflict(
          'PLAN_UNAVAILABLE',
          `La formule ${plan.name} n’est plus proposée`,
        );
    }
    const changes = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    ) as Partial<PlatformSettings>;
    if (Object.keys(changes).length)
      await this.db.manager.update(PlatformSettings, { id: 1 }, changes);
    // Quotas de l'essai : relus par toutes les structures.
    this.db.afterCommit(() => this.subscriptions.invalidateAll());
    await this.log(admin, 'settings.update', null, {
      before: Object.fromEntries(
        Object.keys(changes).map((k) => [
          k,
          before[k as keyof PlatformSettings],
        ]),
      ),
      after: changes,
    });
    return this.settings();
  }
}
