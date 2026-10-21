import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { BusinessException } from './business.exception';
import { RedisService } from './redis.service';

const RATE_LIMIT_KEY = 'rateLimit';

interface Limit {
  limit: number;
  windowSeconds: number;
}

/**
 * Plafond propre à une route (en plus du plafond général), par utilisateur connecté, sinon
 * par adresse IP : ex. @RateLimit(5, 3600) pour 5 appels par heure.
 */
export const RateLimit = (limit: number, windowSeconds: number) =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowSeconds } satisfies Limit);

/** Requêtes sans compte (connexion, pages publiques) : par adresse IP et par minute. */
const perMinute = () => Number(process.env.RATE_LIMIT_PER_MINUTE) || 600;
/** Requêtes d'un utilisateur connecté, par minute (tous ses appareils). */
const perUser = () => Number(process.env.RATE_LIMIT_PER_USER_PER_MINUTE) || 600;
/**
 * Requêtes connectées venant d'une même adresse IP, par minute. Les opérateurs mobiles
 * placent de nombreux téléphones derrière une même adresse (CGNAT) : plafond large, pour
 * ne jamais bloquer une équipe entière, tout en arrêtant un déluge.
 */
const perConnectedIp = () =>
  Number(process.env.RATE_LIMIT_PER_IP_CONNECTED_PER_MINUTE) || 15000;

/**
 * Limite le nombre de requêtes : par utilisateur quand la requête porte un jeton valide
 * (les agents d'un même opérateur ne sont pas regroupés), sinon par adresse IP (robots,
 * scripts). Au-delà, 429 jusqu'à la fin de la fenêtre. Compteurs dans Redis ; si Redis ne
 * répond pas, rien n'est bloqué. RATE_LIMIT=off la désactive (tests de bout en bout).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly jwt = new JwtService();

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /** Utilisateur du jeton d'accès, s'il est valide (signature et date) ; sinon null. */
  private async utilisateur(req: Request): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(
        header.slice(7),
        { secret: this.config.get<string>('JWT_SECRET') },
      );
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http' || process.env.RATE_LIMIT === 'off')
      return true;
    const req = context.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? 'inconnue';
    const user = await this.utilisateur(req);
    const route = this.reflector.getAllAndOverride<Limit | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    const checks: (Limit & { name: string; who: string })[] = user
      ? [
          { name: 'user', who: user, limit: perUser(), windowSeconds: 60 },
          { name: 'ip', who: ip, limit: perConnectedIp(), windowSeconds: 60 },
        ]
      : [{ name: 'all', who: ip, limit: perMinute(), windowSeconds: 60 }];
    if (route)
      checks.push({
        name: `${context.getClass().name}.${context.getHandler().name}`,
        who: user ?? ip,
        ...route,
      });
    for (const check of checks) {
      const slot = Math.floor(Date.now() / 1000 / check.windowSeconds);
      const key = `rl:${check.name}:${check.who}:${slot}`;
      let count: number;
      try {
        const [[, value]] = (await this.redis.client
          .multi()
          .incr(key)
          .expire(key, check.windowSeconds, 'NX')
          .exec()) as [[Error | null, number]];
        count = value;
      } catch {
        return true;
      }
      if (count > check.limit) {
        const retryAfter =
          check.windowSeconds -
          (Math.floor(Date.now() / 1000) % check.windowSeconds);
        throw new BusinessException(
          HttpStatus.TOO_MANY_REQUESTS,
          'TOO_MANY_REQUESTS',
          'Trop de demandes en peu de temps : réessayez dans un instant.',
          { retryAfter },
        );
      }
    }
    return true;
  }
}
