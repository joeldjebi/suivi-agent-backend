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

/** Échecs tolérés pour un compte toutes adresses IP confondues (attaque répartie). */
const ACCOUNT_FACTOR = 10;

/**
 * Protection contre les essais de mots de passe, en 15 minutes :
 * - un compte depuis une même adresse IP : au-delà du seuil, cette adresse ne peut plus s'y
 *   connecter (un tiers ne peut donc pas bloquer le compte de quelqu'un d'autre) ;
 * - un compte toutes adresses confondues : seuil 10 fois plus haut (attaque répartie) ;
 * - une adresse IP, tous comptes confondus.
 * Au-delà, la connexion est refusée, même avec le bon mot de passe, jusqu'à la fin de la fenêtre.
 */
@Injectable()
export class LoginThrottle {
  constructor(private readonly redis: RedisService) {}

  private keys(limits: LoginLimits, ip: string, account: string) {
    const name = account.toLowerCase();
    return {
      ip: `${limits.prefix}:fail:ip:${ip}`,
      accountIp: `${limits.prefix}:fail:account-ip:${name}:${ip}`,
      account: `${limits.prefix}:fail:account:${name}`,
    };
  }

  async assertAllowed(
    limits: LoginLimits,
    ip: string,
    account: string,
  ): Promise<void> {
    const keys = this.keys(limits, ip, account);
    const [byAccountIp, byAccount, byIp] = await this.redis.client.mget(
      keys.accountIp,
      keys.account,
      keys.ip,
    );
    const blocked =
      Number(byAccountIp ?? 0) >= limits.perAccount
        ? keys.accountIp
        : Number(byAccount ?? 0) >= limits.perAccount * ACCOUNT_FACTOR
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
      .incr(keys.accountIp)
      .expire(keys.accountIp, WINDOW_SECONDS, 'NX')
      .incr(keys.account)
      .expire(keys.account, WINDOW_SECONDS, 'NX')
      .incr(keys.ip)
      .expire(keys.ip, WINDOW_SECONDS, 'NX')
      .exec();
  }

  /** Connexion réussie : les compteurs du compte (et de cette adresse) repartent à zéro. */
  async reset(limits: LoginLimits, account: string, ip = ''): Promise<void> {
    const keys = this.keys(limits, ip, account);
    await this.redis.client.del(keys.accountIp, keys.account);
  }
}
