import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Feature, SubscriptionStatus, TenantApprovalStatus } from '@suivi/shared';
import type { Request } from 'express';
import type { AuthUser } from '../common/auth-user';
import { ALLOW_SUSPENDED, REQUIRES_FEATURE } from '../common/decorators';
import {
  SubscriptionsService,
  featureNotInPlan,
  subscriptionSuspended,
  tenantNotApproved,
} from './subscriptions.service';

/**
 * Applique l'abonnement : abonnement suspendu (seuls l'authentification et la facturation
 * restent ouvertes) et fonctionnalités réservées à certaines formules (@RequiresFeature).
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const user = context.switchToHttp().getRequest<Request>().user as
      AuthUser | undefined;
    if (!user) return true; // route publique
    const targets = [context.getHandler(), context.getClass()];
    const summary = await this.subscriptions.summary(user.tenantId);
    const allowSuspended = this.reflector.getAllAndOverride<boolean>(
      ALLOW_SUSPENDED,
      targets,
    );
    // Structure pas encore validée (ou refusée) par l'éditeur : accès bloqué (sauf l'authentification).
    if (
      summary.approvalStatus !== TenantApprovalStatus.Approved &&
      !allowSuspended
    )
      throw tenantNotApproved(summary.approvalStatus);
    if (summary.status === SubscriptionStatus.Suspended && !allowSuspended) {
      throw subscriptionSuspended();
    }
    const required = this.reflector.getAllAndOverride<Feature[] | undefined>(
      REQUIRES_FEATURE,
      targets,
    );
    // L'une des fonctionnalités suffit (ex. formulaires : missions ou points de vente).
    if (required?.length && !required.some((f) => summary.features.includes(f)))
      throw featureNotInPlan(required[0], summary.upgrades[required[0]]);
    return true;
  }
}
