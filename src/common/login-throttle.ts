import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException } from './business.exception';
import { RedisService } from './redis.service';

/** Fenêtre de comptage des échecs de connexion. */
const WINDOW_SECONDS = 15 * 60;

/** Seuils d'un espace de connexion : échecs tolérés par compte, puis par adresse IP. */
export interface LoginLimits {
  prefix: string;
  perAccount: number;
  perIp: number;
}

/** Console de l'éditeur : peu de comptes, seuils serrés. */
export const PLATFORM_LOGIN: LoginLimits = {
  prefix: 'platform',
  perAccount: 5,
  perIp: 20,
};

/**
 * Structures (administrateurs, chefs, agents) : sur les réseaux mobiles, beaucoup de
 * téléphones partagent la même adresse IP de l'opérateur ; le seuil par IP est donc large.
 */
export const APP_LOGIN: LoginLimits = {
  prefix: 'auth',
  perAccount: 5,
  perIp: 50,
};

/**
 * Protection contre les essais de mots de passe : au-delà du seuil d'échecs pour un compte
 * (ou pour une adresse IP) en 15 minutes, la connexion est refusée, même avec le bon mot de
 * passe, jusqu'à la fin de la fenêtre.
 */
@Injectable()
export class LoginThrottle {
  constructor(private readonly redis: RedisService) {}

  private keys(limits: LoginLimits, ip: string, account: string) {
    return {
      ip: `${limits.prefix}:fail:ip:${ip}`,
      account: `${limits.prefix}:fail:account:${account.toLowerCase()}`,
    };
  }

  async assertAllowed(
    limits: LoginLimits,
    ip: string,
    account: string,
  ): Promise<void> {
    const keys = this.keys(limits, ip, account);
    const [byAccount, byIp] = await this.redis.client.mget(
      keys.account,
      keys.ip,
    );
    const blocked =
      Number(byAccount ?? 0) >= limits.perAccount
        ? keys.account
        : Number(byIp ?? 0) >= limits.perIp
          ? keys.ip
          : null;
    if (!blocked) return;
    const ttl = await this.redis.client.ttl(blocked);
    const minutes = Math.max(1, Math.ceil(ttl / 60));
    throw new BusinessException(
      HttpStatus.TOO_MANY_REQUESTS,
      'TOO_MANY_ATTEMPTS',
      `Trop de tentatives de connexion. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`,
      { retryAfter: ttl },
    );
  }

  async fail(limits: LoginLimits, ip: string, account: string): Promise<void> {
    const keys = this.keys(limits, ip, account);
    await this.redis.client
      .multi()
      .incr(keys.account)
      .expire(keys.account, WINDOW_SECONDS, 'NX')
      .incr(keys.ip)
      .expire(keys.ip, WINDOW_SECONDS, 'NX')
      .exec();
  }

  /** Connexion réussie : le compteur du compte repart à zéro. */
  async reset(limits: LoginLimits, account: string): Promise<void> {
    await this.redis.client.del(this.keys(limits, '', account).account);
  }
}
