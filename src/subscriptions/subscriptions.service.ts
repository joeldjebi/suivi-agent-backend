import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  ApprovalMode,
  BillingCycle,
  Feature,
  InvoiceStatus,
  PlanCode,
  SubscriptionStatus,
} from '@suivi/shared';
import { BusinessException, conflict } from '../common/business.exception';
import { DbService } from '../common/db.service';
import {
  Invoice,
  Plan,
  PlatformSettings,
  Subscription,
  TenantSettings,
} from '../entities';
import type { ChangePlanDto } from './subscriptions.dto';

const DAY = 86400_000;
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
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

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
    const estimate = this.estimate(sub, plan, platform, monthStart(now));
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
    // Conditions négociées par l'éditeur : elles priment, essai compris.
    const includedAgents = sub.customIncludedAgents ?? plan.includedAgents;
    return {
      includedAgents,
      agents: includedAgents + sub.extraAgents,
      leads: sub.customIncludedLeads ?? plan.includedLeads,
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
   * Montant d'un mois : forfait + agents supplémentaires, remise annuelle déduite,
   * au prorata des jours après l'essai si celui-ci se termine dans le mois.
   */
  estimate(
    sub: Pick<
      Subscription,
      'trialEndsAt' | 'billingCycle' | 'extraAgents' | 'customMonthlyPrice'
    >,
    plan: Plan,
    platform: PlatformSettings,
    month: Date,
  ) {
    const next = new Date(
      Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1),
    );
    const days = (next.getTime() - month.getTime()) / DAY;
    const billableFrom =
      sub.trialEndsAt && sub.trialEndsAt > month ? sub.trialEndsAt : month;
    const billableDays = Math.max(
      0,
      Math.ceil((next.getTime() - billableFrom.getTime()) / DAY),
    );
    const prorata = Math.min(100, Math.round((billableDays / days) * 100));
    const discount =
      sub.billingCycle === BillingCycle.Annual
        ? platform.annualDiscountPercent
        : 0;
    const basePrice = sub.customMonthlyPrice ?? plan.monthlyPrice;
    const gross = basePrice + sub.extraAgents * plan.extraAgentPrice;
    return {
      month: isoDay(month).slice(0, 7),
      basePrice,
      extraAgents: sub.extraAgents,
      extraAgentPrice: plan.extraAgentPrice,
      discountPercent: discount,
      prorataPercent: prorata,
      amount: Math.round((((gross * (100 - discount)) / 100) * prorata) / 100),
    };
  }

  /**
   * Tâche quotidienne, par structure : fin d'essai, facture du mois écoulé,
   * relance (impayé) puis suspension, et réactivation quand tout est réglé.
   */
  async daily(tenantId: string, now = new Date()) {
    const m = this.db.manager;
    const sub = await m.findOneBy(Subscription, { tenantId });
    if (!sub || sub.status === SubscriptionStatus.Cancelled) return;
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
      const estimate = this.estimate(sub, plan, platform, previous);
      const [{ agents }] = await m.query<{ agents: number }[]>(
        `SELECT count(*)::int AS agents FROM users WHERE role = 'agent' AND is_active`,
      );
      if (estimate.amount > 0) {
        await m.insert(Invoice, {
          tenantId,
          number: `F-${isoDay(previous).slice(0, 7).replace('-', '')}-${tenantId.slice(0, 8).toUpperCase()}`,
          month: isoDay(previous),
          planCode: sub.planCode,
          billingCycle: sub.billingCycle,
          agents,
          basePrice: estimate.basePrice,
          extraAgents: estimate.extraAgents,
          extraAgentPrice: estimate.extraAgentPrice,
          discountPercent: estimate.discountPercent,
          prorataPercent: estimate.prorataPercent,
          amount: estimate.amount,
          currency: platform.currency,
          status: InvoiceStatus.Pending,
          issuedAt: now,
          dueAt: new Date(now.getTime() + platform.invoiceDueDays * DAY),
        });
        this.logger.log(
          `Structure ${tenantId} : facture ${estimate.month} (${estimate.amount} ${platform.currency})`,
        );
      }
    }

    await this.syncStatus(tenantId, now);
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
