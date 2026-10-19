import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { BusinessException } from './business.exception';
import { RedisService } from './redis.service';

const RATE_LIMIT_KEY = 'rateLimit';

interface Limit {
  limit: number;
  windowSeconds: number;
}

/**
 * Plafond propre à une route (en plus du plafond général), par adresse IP :
 * ex. @RateLimit(5, 3600) pour 5 appels par heure.
 */
export const RateLimit = (limit: number, windowSeconds: number) =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowSeconds } satisfies Limit);

/** Plafond général par adresse IP et par minute (réseaux mobiles : IP partagées). */
const perMinute = () => Number(process.env.RATE_LIMIT_PER_MINUTE) || 600;

/**
 * Limite le nombre de requêtes par adresse IP (robots, scripts) : au-delà, 429 jusqu'à la
 * fin de la fenêtre. Compteurs dans Redis ; si Redis ne répond pas, rien n'est bloqué.
 * RATE_LIMIT=off la désactive (tests de bout en bout).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http' || process.env.RATE_LIMIT === 'off')
      return true;
    const req = context.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? 'inconnue';
    const route = this.reflector.getAllAndOverride<Limit | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    const checks: (Limit & { name: string })[] = [
      { name: 'all', limit: perMinute(), windowSeconds: 60 },
    ];
    if (route)
      checks.push({
        name: `${context.getClass().name}.${context.getHandler().name}`,
        ...route,
      });
    for (const check of checks) {
      const slot = Math.floor(Date.now() / 1000 / check.windowSeconds);
      const key = `rl:${check.name}:${ip}:${slot}`;
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
