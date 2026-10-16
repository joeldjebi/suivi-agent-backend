import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

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
