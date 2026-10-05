import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Feature, Role } from '@suivi/shared';
import { Request } from 'express';
import type { AuthUser } from './auth-user';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
/** Route accessible même quand l'abonnement de la structure est suspendu. */
export const ALLOW_SUSPENDED = 'allowSuspended';
export const AllowWhenSuspended = () => SetMetadata(ALLOW_SUSPENDED, true);
/** Route réservée aux formules qui incluent cette fonctionnalité. */
export const REQUIRES_FEATURE = 'requiresFeature';
export const RequiresFeature = (feature: Feature) =>
  SetMetadata(REQUIRES_FEATURE, feature);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<Request>().user as AuthUser,
);
