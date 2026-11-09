import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { In, IsNull } from 'typeorm';
import {
  ApprovalMode,
  BillingCycle,
  Feature,
  InvoiceLineKind,
  InvoiceStatus,
  OnboardingRequestStatus,
  PHOTO_AI_LOT_SIZE,
  PlanCode,
  Role,
  SubscriptionStatus,
} from '@suivi/shared';
import type { InvoiceLine } from '@suivi/shared';
import {
  BusinessException,
  conflict,
  notFound,
} from '../common/business.exception';
import { DbService } from '../common/db.service';
import type { NotificationInput } from '../common/notifications.service';
import {
  Invoice,
  OneTimeCharge,
  OnboardingRequest,
  Plan,
  PlatformSettings,
  Subscription,
  TenantSettings,
} from '../entities';
import type { AuthUser } from '../common/auth-user';
import type { ChangePlanDto, OnboardingRequestDto } from './subscriptions.dto';

const DAY = 86400_000;
/** Les administrateurs sont prévenus de la fin de l'ancien tarif ce nombre de jours avant. */
const LEGACY_NOTICE_DAYS = 30;
/** Cache court : le contrôle d'accès lit l'abonnement à chaque requête. */
const CACHE_MS = 30_000;

export interface SubscriptionSummary {
  status: SubscriptionStatus;
  planCode: PlanCode;
  planName: string;
  billingCycle: BillingCycle;
  trialEndsAt: Date | null;
  /** Fonctionnalités ouvertes maintenant (toutes pendant l'essai, aucune si suspendu) */
  features: Feature[];
  /** Formule la moins chère qui inclut chaque fonctionnalité absente (proposition de changement) */
  upgrades: Partial<Record<Feature, { code: PlanCode; name: string }>>;
}

const ALL_FEATURES = Object.values(Feature);

/** Fonctionnalités d'une formule, limitées à celles que l'application connaît. */
export const planFeatures = (plan: Pick<Plan, 'features'> | undefined) =>
  ALL_FEATURES.filter((f) => plan?.features?.includes(f));

/** Fonctionnalités ouvertes : toutes pendant l'essai, aucune si l'abonnement est suspendu. */
const featuresOf = (
  sub: Pick<Subscription, 'status'>,
  plan: Plan | undefined,
): Feature[] =>
  sub.status === SubscriptionStatus.Suspended
    ? []
    : sub.status === SubscriptionStatus.Trialing
      ? ALL_FEATURES
      : planFeatures(plan);

const monthStart = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const nextMonth = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const frDate = (d: Date) =>
  d.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
const money = (n: number, currency: string) =>
  `${new Intl.NumberFormat('fr-FR').format(n).replace(/\u202f/g, ' ')} ${currency === 'XOF' ? 'FCFA' : currency}`;

/** Champs d'un abonnement qui comptent pour le prix. */
type PricedSubscription = Pick<
  Subscription,
  | 'trialEndsAt'
  | 'billingCycle'
  | 'extraAgents'
  | 'customMonthlyPrice'
  | 'customIncludedAgents'
  | 'customIncludedLeads'
  | 'legacyUntil'
  | 'legacyMonthlyPrice'
  | 'legacyIncludedAgents'
  | 'legacyIncludedLeads'
  | 'legacyExtraAgentPrice'
  | 'legacyPhotoAiQuota'
>;

/** Rappel de fin de l'ancien tarif, à envoyer aux administrateurs de la structure. */
export interface LegacyReminder {
  userIds: string[];
  input: NotificationInput;
}

/** Conditions en vigueur d'un abonnement. */
export interface Terms {
  monthlyPrice: number;
  includedAgents: number;
  includedLeads: number;
  extraAgentPrice: number;
  /** Photos IA comprises chaque mois */
  photoAiQuota: number;
  /** Lot de 100 photos IA au-delà du quota (0 : pas de dépassement facturé) */
  photoAiLotPrice: number;
  /** Camion actif dans le mois (0 : compris) */
  vanPrice: number;
  /** Ancien tarif garanti jusqu'à cette date (null : grille en vigueur) */
  legacyUntil: Date | null;
}

/**
 * Conditions d'un abonnement à une date : celles négociées par l'éditeur d'abord, puis l'ancien
 * tarif tant qu'il est garanti (sans camions ni lots de photos facturés), puis la formule.
 */
export function termsOf(
  sub: PricedSubscription,
  plan: Plan,
  at = new Date(),
): Terms {
  const legacy = !!sub.legacyUntil && sub.legacyUntil > at;
  const pick = (old: number | null, current: number) =>
    legacy ? (old ?? current) : current;
  return {
    monthlyPrice:
      sub.customMonthlyPrice ?? pick(sub.legacyMonthlyPrice, plan.monthlyPrice),
    includedAgents:
      sub.customIncludedAgents ??
      pick(sub.legacyIncludedAgents, plan.includedAgents),
    includedLeads:
      sub.customIncludedLeads ??
      pick(sub.legacyIncludedLeads, plan.includedLeads),
    extraAgentPrice: pick(sub.legacyExtraAgentPrice, plan.extraAgentPrice),
    photoAiQuota: pick(sub.legacyPhotoAiQuota, plan.photoAiMonthlyQuota),
    photoAiLotPrice: legacy ? 0 : plan.photoAiExtraPrice,
    vanPrice: legacy ? 0 : plan.vanPrice,
    legacyUntil: legacy ? sub.legacyUntil : null,
  };
}

/** Ancien tarif levé : changement de formule, ou décision de l'éditeur. */
export const NO_LEGACY = {
  legacyUntil: null,
  legacyMonthlyPrice: null,
  legacyIncludedAgents: null,
  legacyIncludedLeads: null,
  legacyExtraAgentPrice: null,
  legacyPhotoAiQuota: null,
  legacyNotifiedAt: null,
} satisfies Partial<Subscription>;

export const featureNotInPlan = (
  feature: Feature,
  upgrade?: { code: PlanCode; name: string },
) =>
  new BusinessException(
    HttpStatus.PAYMENT_REQUIRED,
    'FEATURE_NOT_IN_PLAN',
    'Cette fonctionnalité n’est pas incluse dans votre formule',
    {
      feature,
      requiredPlan: upgrade?.code ?? null,
      requiredPlanName: upgrade?.name ?? null,
    },
  );

export const subscriptionSuspended = () =>
  new BusinessException(
    HttpStatus.PAYMENT_REQUIRED,
    'SUBSCRIPTION_SUSPENDED',
    'L’abonnement de votre structure est suspendu. Contactez votre administrateur.',
  );

/** Abonnement des structures : formule, essai, engagement annuel, factures mensuelles. */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly cache = new Map<
    string,
    { at: number; value: SubscriptionSummary }
  >();

  private catalogCache: { at: number; plans: Plan[] } | null = null;

  constructor(private readonly db: DbService) {}

  async platform(): Promise<PlatformSettings> {
    return this.db.manager.findOneByOrFail(PlatformSettings, { id: 1 });
  }

  /** Formules proposées aux structures. */
  async plans(): Promise<Plan[]> {
    return (await this.catalog()).filter((p) => p.isActive);
  }

  /** Tout le catalogue (formules retirées comprises), mis en cache comme les résumés. */
  async catalog(): Promise<Plan[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CACHE_MS)
      return this.catalogCache.plans;
    // Transaction à part : le contrôle d'accès s'exécute avant celle de la requête.
    const plans = await this.db.runAsSystem(() =>
      this.db.manager.find(Plan, {
        order: { sort: 'ASC', monthlyPrice: 'ASC' },
      }),
    );
    this.catalogCache = { at: Date.now(), plans };
    return plans;
  }

  /** Formule proposée la moins chère qui inclut chaque fonctionnalité. */
  private upgradesFrom(plans: Plan[], open: Feature[]) {
    const offered = plans
      .filter((p) => p.isActive)
      .sort((a, b) => a.monthlyPrice - b.monthlyPrice || a.sort - b.sort);
    const upgrades: SubscriptionSummary['upgrades'] = {};
    for (const feature of ALL_FEATURES) {
      if (open.includes(feature)) continue;
      const plan = offered.find((p) => p.features.includes(feature));
      if (plan) upgrades[feature] = { code: plan.code, name: plan.name };
    }
    return upgrades;
  }

  /** Abonnement d'une nouvelle structure : essai gratuit, puis la formule choisie par l'éditeur. */
  async startTrial(tenantId: string): Promise<void> {
    const platform = await this.platform();
    await this.db.manager.insert(Subscription, {
      tenantId,
      planCode: platform.defaultPlanCode,
      billingCycle: BillingCycle.Monthly,
      status: SubscriptionStatus.Trialing,
      trialEndsAt: new Date(Date.now() + platform.trialDays * DAY),
    });
  }

  /** Résumé pour le contrôle d'accès et le profil (/auth/me), mis en cache. */
  async summary(tenantId: string): Promise<SubscriptionSummary> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const plans = await this.catalog();
    const value = await this.db.runAsTenant(
      tenantId,
      async (): Promise<SubscriptionSummary> => {
        const sub = await this.db.manager.findOneBy(Subscription, {
          tenantId,
        });
        // Structure sans abonnement (ancienne donnée) : toutes les fonctionnalités.
        if (!sub)
          return {
            status: SubscriptionStatus.Active,
            planCode: PlanCode.Enterprise,
            planName: 'Entreprise',
            billingCycle: BillingCycle.Monthly,
            trialEndsAt: null,
            features: ALL_FEATURES,
            upgrades: {},
          };
        const plan = plans.find((p) => p.code === sub.planCode);
        const features = featuresOf(sub, plan);
        return {
          status: sub.status,
          planCode: sub.planCode,
          planName: plan?.name ?? sub.planCode,
          billingCycle: sub.billingCycle,
          trialEndsAt: sub.trialEndsAt,
          features,
          upgrades: this.upgradesFrom(plans, features),
        };
      },
    );
    this.cache.set(tenantId, { at: Date.now(), value });
    return value;
  }

  invalidate(tenantId: string) {
    this.cache.delete(tenantId);
  }

  /** Catalogue modifié par l'éditeur : tous les résumés sont relus. */
  invalidateAll() {
    this.cache.clear();
    this.catalogCache = null;
  }

  async assertFeature(tenantId: string, feature: Feature): Promise<void> {
    const { features } = await this.summary(tenantId);
    if (!features.includes(feature))
      throw featureNotInPlan(
        feature,
        (await this.summary(tenantId)).upgrades[feature],
      );
  }

  /** Page « Abonnement » de l'administrateur. */
  async details() {
    const m = this.db.manager;
    const tenantId = this.db.tenantId;
    const sub = await m.findOneByOrFail(Subscription, { tenantId });
    const platform = await this.platform();
    const catalog = await this.catalog();
    // Formules proposées, plus la formule actuelle si l'éditeur l'a retirée du catalogue.
    const plans = catalog.filter((p) => p.isActive || p.code === sub.planCode);
    const plan = catalog.find((p) => p.code === sub.planCode)!;
    const now = new Date();
    // Le mois en cours, avec ce qui est déjà consommé (camions, photos) et les frais en attente.
    const estimate = await this.bill(sub, plan, platform, monthStart(now), {
      until: now,
    });
    const terms = termsOf(sub, plan, now);
    const usage = await this.usage(sub, catalog);
    const [unpaid] = await m.query<{ count: number; amount: number }[]>(
      `SELECT count(*)::int AS count, coalesce(sum(amount), 0)::int AS amount
       FROM invoices WHERE status = 'pending'`,
    );
    return {
      subscription: sub,
      plan,
      plans: plans.map((p) => ({ ...p, features: planFeatures(p) })),
      currency: platform.currency,
      annualDiscountPercent: platform.annualDiscountPercent,
      terms,
      // Ancien tarif garanti : sa fin, et le forfait d'un mois complet ensuite (formule actuelle).
      legacy: terms.legacyUntil
        ? {
            until: terms.legacyUntil,
            current: this.estimate(sub, plan, platform, monthStart(now), {
              full: true,
            }).amount,
            after: this.estimate(
              { ...sub, ...NO_LEGACY },
              plan,
              platform,
              monthStart(now),
              { full: true },
            ).amount,
          }
        : null,
      onboardingPackages: platform.onboardingPackages,
      trialDaysLeft:
        sub.status === SubscriptionStatus.Trialing && sub.trialEndsAt
          ? Math.max(
              0,
              Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / DAY),
            )
          : null,
      features: featuresOf(sub, plan),
      estimate,
      usage,
      unpaid,
    };
  }

  /** Comptes actifs (agents, chefs d'équipe) face aux quotas de la formule. */
  async usage(sub: Subscription, plans?: Plan[]) {
    const [{ agents, leads }] = await this.db.manager.query<
      { agents: number; leads: number }[]
    >(
      `SELECT count(*) FILTER (WHERE role = 'agent')::int AS agents,
              count(*) FILTER (WHERE role = 'team_lead')::int AS leads
       FROM users WHERE is_active`,
    );
    const limits = await this.limits(sub, plans);
    return {
      agents: {
        used: agents,
        included: limits.includedAgents,
        extra: sub.extraAgents,
        limit: limits.agents,
      },
      leads: { used: leads, limit: limits.leads },
    };
  }

  /** Quotas en vigueur : pendant l'essai, ceux de la formule d'essai choisie par l'éditeur. */
  private async limits(sub: Subscription, plans?: Plan[]) {
    const list = plans ?? (await this.catalog());
    const code =
      sub.status === SubscriptionStatus.Trialing
        ? (await this.platform()).trialPlanCode
        : sub.planCode;
    const plan = list.find((p) => p.code === code)!;
    // Conditions négociées par l'éditeur, puis l'ancien tarif garanti (hors essai), puis la formule.
    const terms = termsOf(
      sub.status === SubscriptionStatus.Trialing
        ? { ...sub, ...NO_LEGACY }
        : sub,
      plan,
    );
    return {
      includedAgents: terms.includedAgents,
      agents: terms.includedAgents + sub.extraAgents,
      leads: terms.includedLeads,
    };
  }

  /** Utilisation des quotas de la structure courante (null sans abonnement). */
  async quota() {
    const sub = await this.db.manager.findOneBy(Subscription, {
      tenantId: this.db.tenantId,
    });
    return sub ? this.usage(sub) : null;
  }

  /**
   * Création ou réactivation d'un compte : refusée au-delà du quota de la formule
   * (agents supplémentaires achetables depuis la page Abonnement).
   */
  async assertQuota(role: string): Promise<void> {
    if (role !== 'agent' && role !== 'team_lead') return;
    const sub = await this.db.manager.findOneBy(Subscription, {
      tenantId: this.db.tenantId,
    });
    if (!sub) return;
    const usage = await this.usage(sub);
    const quota = role === 'agent' ? usage.agents : usage.leads;
    if (quota.used + 1 > quota.limit) {
      throw new BusinessException(
        HttpStatus.CONFLICT,
        'QUOTA_EXCEEDED',
        role === 'agent'
          ? `Votre formule permet ${quota.limit} agents actifs. Ajoutez des agents supplémentaires ou changez de formule.`
          : `Votre formule permet ${quota.limit} chef${quota.limit > 1 ? 's' : ''} d’équipe actif${quota.limit > 1 ? 's' : ''}. Changez de formule pour en ajouter.`,
        { role, used: quota.used, limit: quota.limit },
      );
    }
  }

  async invoices(): Promise<Invoice[]> {
    return this.db.manager.find(Invoice, { order: { month: 'DESC' } });
  }

  // ------------------------------------------------------------ mise en place

  /** Demandes de mise en place de la structure courante, les plus récentes d'abord. */
  onboardingRequests(): Promise<OnboardingRequest[]> {
    return this.db.manager.find(OnboardingRequest, {
      where: { tenantId: this.db.tenantId },
      order: { createdAt: 'DESC' },
      take: 20,
    });
  }

  /**
   * Demande d'un forfait de mise en place proposé par l'éditeur (nom et prix figés à cet
   * instant). Une seule demande en attente à la fois.
   */
  async requestOnboarding(user: AuthUser, dto: OnboardingRequestDto) {
    const pkg = (await this.platform()).onboardingPackages.find(
      (p) => p.code === dto.packageCode,
    );
    if (!pkg) throw notFound('Forfait de mise en place');
    const m = this.db.manager;
    const pending = await m.findOneBy(OnboardingRequest, {
      tenantId: this.db.tenantId,
      status: OnboardingRequestStatus.Pending,
    });
    if (pending)
      throw conflict(
        'ONBOARDING_REQUEST_PENDING',
        `Votre demande « ${pending.packageName} » attend déjà une réponse`,
      );
    return m.save(OnboardingRequest, {
      tenantId: this.db.tenantId,
      packageCode: pkg.code,
      packageName: pkg.name,
      packagePrice: pkg.price,
      message: dto.message?.trim() || null,
      status: OnboardingRequestStatus.Pending,
      requestedBy: user.id,
    });
  }

  /** La structure retire sa demande tant que l'éditeur n'a pas répondu. */
  async cancelOnboarding(id: string) {
    const m = this.db.manager;
    const request = await m.findOneBy(OnboardingRequest, {
      id,
      tenantId: this.db.tenantId,
    });
    if (!request) throw notFound('Demande');
    if (request.status !== OnboardingRequestStatus.Pending)
      throw conflict(
        'ONBOARDING_REQUEST_DECIDED',
        'L’éditeur a déjà répondu à cette demande',
      );
    await m.update(
      OnboardingRequest,
      { id },
      { status: OnboardingRequestStatus.Cancelled, decidedAt: new Date() },
    );
    return m.findOneByOrFail(OnboardingRequest, { id });
  }

  /**
   * Changement de formule ou de cycle. L'engagement annuel court 12 mois ;
   * on ne repasse au mensuel qu'à son terme. Une formule inférieure n'est acceptée
   * que si la structure n'utilise plus les fonctionnalités qu'elle perdrait.
   */
  async change(dto: ChangePlanDto) {
    const m = this.db.manager;
    const tenantId = this.db.tenantId;
    const sub = await m.findOneByOrFail(Subscription, { tenantId });
    const planCode = dto.planCode ?? sub.planCode;
    const cycle = dto.billingCycle ?? sub.billingCycle;
    const extraAgents = dto.extraAgents ?? sub.extraAgents;
    if (!(await m.findOneBy(Plan, { code: planCode, isActive: true })))
      throw conflict('PLAN_UNAVAILABLE', 'Cette formule n’est pas disponible');
    // Conditions négociées avec l'éditeur : elles valent pour la formule convenue.
    const negotiated =
      sub.customMonthlyPrice !== null ||
      sub.customIncludedAgents !== null ||
      sub.customIncludedLeads !== null;
    if (negotiated && planCode !== sub.planCode)
      throw conflict(
        'CUSTOM_TERMS',
        'Votre abonnement a des conditions négociées : contactez-nous pour changer de formule',
      );

    if (
      sub.billingCycle === BillingCycle.Annual &&
      cycle === BillingCycle.Monthly &&
      sub.commitmentEndsAt &&
      sub.commitmentEndsAt > new Date()
    ) {
      throw new BusinessException(
        HttpStatus.CONFLICT,
        'COMMITMENT_ACTIVE',
        `Votre engagement annuel court jusqu’au ${sub.commitmentEndsAt.toLocaleDateString('fr-FR')}`,
        { commitmentEndsAt: sub.commitmentEndsAt },
      );
    }

    const kept = planFeatures(
      (await this.catalog()).find((p) => p.code === planCode),
    );
    const settings = await m.findOneByOrFail(TenantSettings, { tenantId });
    const blocking: string[] = [];
    if (settings.useGroups && !kept.includes(Feature.Groups))
      blocking.push('Désactivez les groupes dans les paramètres');
    if (
      settings.approvalMode !== ApprovalMode.Automatic &&
      !kept.includes(Feature.ManualApproval)
    )
      blocking.push('Repassez la validation des zones en automatique');
    // Quotas de la nouvelle formule (l'essai garde les quotas Entreprise jusqu'à sa fin).
    const target = { ...sub, planCode, extraAgents };
    const after = await this.usage(target);
    if (after.agents.used > after.agents.limit)
      blocking.push(
        `Désactivez ${after.agents.used - after.agents.limit} agent(s) ou ajoutez des agents supplémentaires (${after.agents.used} actifs pour ${after.agents.limit} autorisés)`,
      );
    if (after.leads.used > after.leads.limit)
      blocking.push(
        `Désactivez ${after.leads.used - after.leads.limit} chef(s) d’équipe (${after.leads.used} actifs pour ${after.leads.limit} autorisés)`,
      );
    if (blocking.length) {
      throw new BusinessException(
        HttpStatus.CONFLICT,
        'PLAN_DOWNGRADE_BLOCKED',
        'Cette formule ne couvre pas ce que vous utilisez actuellement',
        { blocking },
      );
    }

    await m.update(
      Subscription,
      { tenantId },
      {
        // Nouvelle formule : la grille en vigueur s'applique (fin de l'ancien tarif garanti).
        ...(planCode !== sub.planCode ? NO_LEGACY : {}),
        planCode,
        billingCycle: cycle,
        extraAgents,
        commitmentEndsAt:
          cycle === BillingCycle.Annual &&
          sub.billingCycle !== BillingCycle.Annual
            ? new Date(Date.now() + 365 * DAY)
            : cycle === BillingCycle.Monthly
              ? null
              : sub.commitmentEndsAt,
      },
    );
    // Le cache est relu dans une autre transaction : on le vide une fois la modification validée.
    this.db.afterCommit(() => this.invalidate(tenantId));
    return this.details();
  }

  /**
   * Forfait d'un mois : formule + agents supplémentaires, remise annuelle déduite, au prorata
   * des jours après l'essai si celui-ci se termine dans le mois (`full` : mois complet). Les
   * conditions sont celles en vigueur au début du mois (ancien tarif garanti compris).
   */
  estimate(
    sub: PricedSubscription,
    plan: Plan,
    platform: PlatformSettings,
    month: Date,
    options: { full?: boolean } = {},
  ) {
    const next = nextMonth(month);
    const days = (next.getTime() - month.getTime()) / DAY;
    const billableFrom =
      !options.full && sub.trialEndsAt && sub.trialEndsAt > month
        ? sub.trialEndsAt
        : month;
    const billableDays = Math.max(
      0,
      Math.ceil((next.getTime() - billableFrom.getTime()) / DAY),
    );
    const prorata = Math.min(100, Math.round((billableDays / days) * 100));
    const discount =
      sub.billingCycle === BillingCycle.Annual
        ? platform.annualDiscountPercent
        : 0;
    const terms = termsOf(sub, plan, month);
    const basePrice = terms.monthlyPrice;
    const gross = basePrice + sub.extraAgents * terms.extraAgentPrice;
    return {
      month: isoDay(month).slice(0, 7),
      basePrice,
      extraAgents: sub.extraAgents,
      extraAgentPrice: terms.extraAgentPrice,
      discountPercent: discount,
      prorataPercent: prorata,
      amount: Math.round((((gross * (100 - discount)) / 100) * prorata) / 100),
      terms,
    };
  }

  /**
   * Ce qui s'est passé dans le mois pour la structure courante : camions actifs (au moins un
   * mouvement de stock), photos IA analysées depuis `photosFrom`, supplément de l'éditeur.
   */
  private async monthUsage(month: Date, until: Date, photosFrom: Date) {
    const [row] = await this.db.manager.query<
      { vans: number; photos: number; bonus: number }[]
    >(
      `SELECT (SELECT count(*) FROM stock_locations l
                WHERE l.tenant_id = $5 AND l.kind = 'van' AND EXISTS (
                  SELECT 1 FROM stock_movements mv
                  WHERE (mv.from_location_id = l.id OR mv.to_location_id = l.id)
                    AND mv.status <> 'cancelled'
                    AND mv.occurred_at >= $1 AND mv.occurred_at < $2))::int AS vans,
              (SELECT count(*) FROM photo_analyses
                WHERE tenant_id = $5 AND status = 'done'
                  AND created_at >= $3 AND created_at < $2)::int AS photos,
              coalesce((SELECT photos FROM photo_ai_bonuses
                        WHERE tenant_id = $5 AND month = $4), 0)::int AS bonus`,
      [month, until, photosFrom, isoDay(month).slice(0, 7), this.db.tenantId],
    );
    return row;
  }

  /**
   * Facture d'un mois, ligne par ligne : forfait et agents en plus (remise annuelle déduite),
   * camions actifs, lots de photos IA au-delà du quota, frais de mise en place pas encore
   * facturés. `until` : mois en cours compté jusqu'à cet instant (estimation).
   */
  async bill(
    sub: Subscription,
    plan: Plan,
    platform: PlatformSettings,
    month: Date,
    options: { until?: Date } = {},
  ) {
    const base = this.estimate(sub, plan, platform, month);
    const { terms } = base;
    const end = nextMonth(month);
    const until = options.until && options.until < end ? options.until : end;
    // Les photos de l'essai relevaient de la formule d'essai : elles ne sont pas facturées.
    const photosFrom =
      sub.trialEndsAt && sub.trialEndsAt > month ? sub.trialEndsAt : month;
    const used = await this.monthUsage(month, until, photosFrom);
    const vanCount = terms.vanPrice > 0 ? used.vans : 0;
    const included = terms.photoAiQuota + used.bonus;
    const over = Math.max(0, used.photos - included);
    const photoAiLots =
      terms.photoAiLotPrice > 0 ? Math.ceil(over / PHOTO_AI_LOT_SIZE) : 0;
    const charges = await this.db.manager.find(OneTimeCharge, {
      where: { tenantId: this.db.tenantId, invoiceId: IsNull() },
      order: { createdAt: 'ASC' },
    });

    const lines: InvoiceLine[] = [];
    const share = (n: number) => Math.round((n * base.prorataPercent) / 100);
    lines.push({
      kind: InvoiceLineKind.Plan,
      label: [
        `Formule ${plan.name}`,
        base.prorataPercent < 100
          ? `${base.prorataPercent} % du mois, après l’essai`
          : null,
        terms.legacyUntil ? 'tarif garanti' : null,
      ]
        .filter(Boolean)
        .join(' · '),
      quantity: 1,
      unitPrice: base.basePrice,
      amount: share(base.basePrice),
    });
    if (sub.extraAgents > 0)
      lines.push({
        kind: InvoiceLineKind.ExtraAgents,
        label: 'Agents en plus',
        quantity: sub.extraAgents,
        unitPrice: terms.extraAgentPrice,
        amount: share(sub.extraAgents * terms.extraAgentPrice),
      });
    const recurring = lines.reduce((s, l) => s + l.amount, 0);
    if (base.discountPercent > 0 && base.amount !== recurring)
      lines.push({
        kind: InvoiceLineKind.Discount,
        label: `Remise annuelle de ${base.discountPercent} %`,
        quantity: 1,
        unitPrice: base.amount - recurring,
        amount: base.amount - recurring,
      });
    if (vanCount > 0)
      lines.push({
        kind: InvoiceLineKind.Vans,
        label: 'Vente en camion : camions actifs dans le mois',
        quantity: vanCount,
        unitPrice: terms.vanPrice,
        amount: vanCount * terms.vanPrice,
      });
    if (photoAiLots > 0)
      lines.push({
        kind: InvoiceLineKind.PhotoAi,
        label: `IA photo : ${over} photo${over > 1 ? 's' : ''} au-delà des ${included} comprises, par lot de ${PHOTO_AI_LOT_SIZE}`,
        quantity: photoAiLots,
        unitPrice: terms.photoAiLotPrice,
        amount: photoAiLots * terms.photoAiLotPrice,
      });
    for (const c of charges)
      lines.push({
        kind: InvoiceLineKind.OneTime,
        label: c.label,
        quantity: 1,
        unitPrice: c.amount,
        amount: c.amount,
      });
    const oneTimeAmount = charges.reduce((s, c) => s + c.amount, 0);
    return {
      ...base,
      /** Forfait et agents en plus, remise déduite */
      recurringAmount: base.amount,
      vanCount,
      vanPrice: terms.vanPrice,
      photoAiPhotos: used.photos,
      photoAiIncluded: included,
      photoAiLots,
      photoAiLotPrice: terms.photoAiLotPrice,
      oneTimeAmount,
      charges,
      lines,
      amount:
        base.amount +
        vanCount * terms.vanPrice +
        photoAiLots * terms.photoAiLotPrice +
        oneTimeAmount,
    };
  }

  /**
   * Tâche quotidienne, par structure : fin d'essai, facture du mois écoulé, relance (impayé)
   * puis suspension, et réactivation quand tout est réglé. Rend le rappel de fin de l'ancien
   * tarif à envoyer aux administrateurs (les notifications dépendent des abonnements : c'est
   * la tâche planifiée qui l'envoie).
   */
  async daily(
    tenantId: string,
    now = new Date(),
  ): Promise<LegacyReminder | null> {
    const m = this.db.manager;
    const sub = await m.findOneBy(Subscription, { tenantId });
    if (!sub || sub.status === SubscriptionStatus.Cancelled) return null;
    const platform = await this.platform();

    if (
      sub.status === SubscriptionStatus.Trialing &&
      sub.trialEndsAt &&
      sub.trialEndsAt <= now
    ) {
      sub.status = SubscriptionStatus.Active;
      await m.update(Subscription, { tenantId }, { status: sub.status });
      this.db.afterCommit(() => this.invalidate(tenantId));
    }

    // Facture du mois précédent, une seule fois.
    const previous = monthStart(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
    );
    const exists = await m.findOneBy(Invoice, {
      tenantId,
      month: isoDay(previous),
    });
    const trialCoversMonth =
      sub.trialEndsAt && sub.trialEndsAt >= monthStart(now);
    if (!exists && !trialCoversMonth) {
      const plan = await m.findOneByOrFail(Plan, { code: sub.planCode });
      const bill = await this.bill(sub, plan, platform, previous);
      const [{ agents }] = await m.query<{ agents: number }[]>(
        `SELECT count(*)::int AS agents FROM users WHERE role = 'agent' AND is_active`,
      );
      if (bill.amount > 0) {
        const { identifiers } = await m.insert(Invoice, {
          tenantId,
          number: `F-${isoDay(previous).slice(0, 7).replace('-', '')}-${tenantId.slice(0, 8).toUpperCase()}`,
          month: isoDay(previous),
          planCode: sub.planCode,
          billingCycle: sub.billingCycle,
          agents,
          basePrice: bill.basePrice,
          extraAgents: bill.extraAgents,
          extraAgentPrice: bill.extraAgentPrice,
          discountPercent: bill.discountPercent,
          prorataPercent: bill.prorataPercent,
          vanCount: bill.vanCount,
          vanPrice: bill.vanPrice,
          photoAiLots: bill.photoAiLots,
          photoAiLotPrice: bill.photoAiLotPrice,
          oneTimeAmount: bill.oneTimeAmount,
          lines: bill.lines,
          amount: bill.amount,
          currency: platform.currency,
          status: InvoiceStatus.Pending,
          issuedAt: now,
          dueAt: new Date(now.getTime() + platform.invoiceDueDays * DAY),
        });
        if (bill.charges.length)
          await m.update(
            OneTimeCharge,
            { id: In(bill.charges.map((c) => c.id)) },
            { invoiceId: (identifiers[0] as { id: string }).id },
          );
        this.logger.log(
          `Structure ${tenantId} : facture ${bill.month} (${bill.amount} ${platform.currency})`,
        );
      }
    }

    const reminder = await this.legacyReminder(sub, platform, now);
    await this.syncStatus(tenantId, now);
    return reminder;
  }

  /**
   * Un mois avant la fin de l'ancien tarif garanti, les administrateurs sont prévenus une fois :
   * date, forfait actuel et forfait à venir (même formule, mêmes agents en plus).
   */
  private async legacyReminder(
    sub: Subscription,
    platform: PlatformSettings,
    now: Date,
  ): Promise<LegacyReminder | null> {
    if (!sub.legacyUntil || sub.legacyNotifiedAt || sub.legacyUntil <= now)
      return null;
    if (sub.legacyUntil.getTime() - now.getTime() > LEGACY_NOTICE_DAYS * DAY)
      return null;
    const m = this.db.manager;
    const plan = await m.findOneByOrFail(Plan, { code: sub.planCode });
    const month = monthStart(now);
    const before = this.estimate(sub, plan, platform, month, { full: true });
    const after = this.estimate(
      { ...sub, ...NO_LEGACY },
      plan,
      platform,
      month,
      {
        full: true,
      },
    );
    const admins = await m.query<{ id: string }[]>(
      `SELECT id FROM users WHERE role = $1 AND is_active`,
      [Role.Admin],
    );
    await m.update(
      Subscription,
      { tenantId: sub.tenantId },
      { legacyNotifiedAt: now },
    );
    return {
      userIds: admins.map((a) => a.id),
      input: {
        type: 'subscription.price_change',
        title: 'Votre tarif évolue',
        body: `À partir du ${frDate(sub.legacyUntil)}, votre formule ${plan.name} passera de ${money(before.amount, platform.currency)} à ${money(after.amount, platform.currency)} par mois (hors options). Détails dans Abonnement.`,
        data: {
          legacyUntil: sub.legacyUntil.toISOString(),
          before: before.amount,
          after: after.amount,
        },
      },
    };
  }

  /**
   * Statut selon les factures : en retard après l'échéance, suspendu après le délai de grâce,
   * actif quand tout est réglé. Une suspension décidée par l'éditeur n'est jamais levée ici.
   */
  async syncStatus(tenantId: string, now = new Date()) {
    const m = this.db.manager;
    const sub = await m.findOneBy(Subscription, { tenantId });
    if (
      !sub ||
      sub.manualSuspension ||
      sub.status === SubscriptionStatus.Cancelled ||
      sub.status === SubscriptionStatus.Trialing
    )
      return;
    const platform = await this.platform();
    const [{ overdue, oldest }] = await m.query<
      { overdue: number; oldest: Date | null }[]
    >(
      `SELECT count(*)::int AS overdue, min(due_at) AS oldest
       FROM invoices WHERE tenant_id = $2 AND status = 'pending' AND due_at < $1`,
      [now, tenantId],
    );
    let status = sub.status;
    if (overdue === 0) {
      if (
        status === SubscriptionStatus.PastDue ||
        status === SubscriptionStatus.Suspended
      )
        status = SubscriptionStatus.Active;
    } else if (
      oldest &&
      oldest.getTime() + platform.suspendAfterDays * DAY < now.getTime()
    ) {
      status = SubscriptionStatus.Suspended;
    } else if (status !== SubscriptionStatus.Suspended) {
      status = SubscriptionStatus.PastDue;
    }
    if (status !== sub.status) {
      await m.update(
        Subscription,
        { tenantId },
        {
          status,
          suspendedAt: status === SubscriptionStatus.Suspended ? now : null,
        },
      );
      this.db.afterCommit(() => this.invalidate(tenantId));
    }
  }
}
