import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException } from '../common/business.exception';
import { ConfigService } from '@nestjs/config';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Public } from '../common/decorators';
import { SessionRevocationService } from '../common/session-revocation.service';
import { PlatformIpGuard } from './platform-security';

/** Compte de l'éditeur connecté, disponible dans `req.platformAdmin` (jamais dans `req.user`). */
export interface PlatformUser {
  id: string;
  email: string;
  /** Session ouverte avec la double authentification active */
  mfa?: boolean;
}

export interface PlatformJwtPayload {
  sub: string;
  email: string;
  scope: 'platform';
  /** Double authentification active à l'ouverture de la session */
  mfa?: boolean;
  iat?: number;
  iam?: number;
}

/**
 * Secret distinct de celui des structures : un jeton de structure n'ouvre jamais
 * l'espace de l'éditeur, et inversement.
 */
export const platformSecret = (config: ConfigService) =>
  config.get<string>('PLATFORM_JWT_SECRET') ??
  `${config.getOrThrow<string>('JWT_SECRET')}::platform`;

@Injectable()
export class PlatformJwtStrategy extends PassportStrategy(
  Strategy,
  'platform-jwt',
) {
  constructor(
    config: ConfigService,
    private readonly revocation: SessionRevocationService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: platformSecret(config),
    });
  }

  async validate(payload: PlatformJwtPayload): Promise<PlatformUser> {
    if (
      payload.scope !== 'platform' ||
      (await this.revocation.isRevoked(payload.sub, payload))
    ) {
      throw new UnauthorizedException('Session révoquée');
    }
    return { id: payload.sub, email: payload.email, mfa: !!payload.mfa };
  }
}

/** Route ouverte sans double authentification (connexion, mise en place de la 2FA). */
export const ALLOW_WITHOUT_MFA = 'platformAllowWithoutMfa';
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA, true);

/** Double authentification obligatoire pour tous les comptes éditeur (PLATFORM_REQUIRE_MFA=true). */
export const mfaRequired = (config: ConfigService) =>
  config.get<string>('PLATFORM_REQUIRE_MFA') === 'true';

/**
 * Garde de l'espace éditeur. La requête s'exécute hors structure (toutes les structures).
 * Si la double authentification est obligatoire, un compte qui ne l'a pas encore activée
 * n'accède qu'à sa mise en place (403 MFA_SETUP_REQUIRED).
 */
@Injectable()
export class PlatformAuthGuard extends AuthGuard('platform-jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {
    super();
  }

  getAuthenticateOptions() {
    return { property: 'platformAdmin', session: false };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!(await super.canActivate(context))) return false;
    const admin = (
      context.switchToHttp().getRequest<Request>() as Request & {
        platformAdmin?: PlatformUser;
      }
    ).platformAdmin;
    const exempt = this.reflector.getAllAndOverride<boolean>(
      ALLOW_WITHOUT_MFA,
      [context.getHandler(), context.getClass()],
    );
    if (mfaRequired(this.config) && !admin?.mfa && !exempt)
      throw new BusinessException(
        HttpStatus.FORBIDDEN,
        'MFA_SETUP_REQUIRED',
        'Activez la double authentification pour accéder à la console',
      );
    return true;
  }
}

/**
 * Route de l'espace éditeur : la garde des structures est contournée (@Public),
 * celle de l'éditeur s'applique.
 */
export const PlatformRoute = () =>
  applyDecorators(
    Public(),
    UseGuards(PlatformIpGuard, PlatformAuthGuard),
    ApiBearerAuth(),
  );

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    (
      context.switchToHttp().getRequest<Request>() as Request & {
        platformAdmin: PlatformUser;
      }
    ).platformAdmin,
);
