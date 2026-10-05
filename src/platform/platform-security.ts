import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { BusinessException } from '../common/business.exception';
import { RedisService } from '../common/redis.service';

/** Fenêtre de comptage des échecs de connexion. */
const WINDOW_SECONDS = 15 * 60;
/** Échecs tolérés par compte, puis par adresse IP, dans la fenêtre. */
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 20;

/** Adresse du client (derrière un proxy : TRUST_PROXY doit être réglé). */
export const clientIp = (req: Request) =>
  (req.ip ?? '').replace(/^::ffff:/, '');

/**
 * Liste blanche facultative (PLATFORM_ALLOWED_IPS, séparées par des virgules) :
 * hors liste, l'espace éditeur répond « introuvable », comme s'il n'existait pas.
 */
@Injectable()
export class PlatformIpGuard implements CanActivate {
  private readonly allowed: string[];

  constructor(config: ConfigService) {
    this.allowed = (config.get<string>('PLATFORM_ALLOWED_IPS') ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.allowed.length) return true;
    const ip = clientIp(context.switchToHttp().getRequest<Request>());
    if (!this.allowed.includes(ip)) throw new NotFoundException();
    return true;
  }
}

/**
 * Protection contre les essais de mots de passe : au-delà de 5 échecs pour un compte
 * (ou 20 pour une adresse IP) en 15 minutes, la connexion est refusée, même avec
 * le bon mot de passe, jusqu'à la fin de la fenêtre.
 */
@Injectable()
export class LoginThrottle {
  constructor(private readonly redis: RedisService) {}

  private keys(ip: string, email: string) {
    return {
      ip: `platform:fail:ip:${ip}`,
      email: `platform:fail:email:${email.toLowerCase()}`,
    };
  }

  async assertAllowed(ip: string, email: string): Promise<void> {
    const keys = this.keys(ip, email);
    const [byEmail, byIp] = await this.redis.client.mget(keys.email, keys.ip);
    const blocked =
      Number(byEmail ?? 0) >= MAX_PER_EMAIL
        ? keys.email
        : Number(byIp ?? 0) >= MAX_PER_IP
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

  async fail(ip: string, email: string): Promise<void> {
    const keys = this.keys(ip, email);
    await this.redis.client
      .multi()
      .incr(keys.email)
      .expire(keys.email, WINDOW_SECONDS, 'NX')
      .incr(keys.ip)
      .expire(keys.ip, WINDOW_SECONDS, 'NX')
      .exec();
  }

  /** Connexion réussie : le compteur du compte repart à zéro. */
  async reset(email: string): Promise<void> {
    await this.redis.client.del(this.keys('', email).email);
  }
}
