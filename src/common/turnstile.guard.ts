import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { REQUIRES_CAPTCHA } from './decorators';
import { SecurityEventsService } from './security-events.service';
import { TurnstileService } from './turnstile.service';

/**
 * Exige un jeton Turnstile valide sur les routes marquées @RequiresCaptcha() (inscription,
 * demande de démo). Sans effet si le CAPTCHA n'est pas configuré. Le jeton est lu dans
 * l'en-tête `x-captcha-token` (jamais dans le corps : les DTO refusent les champs inconnus).
 */
@Injectable()
export class TurnstileGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly turnstile: TurnstileService,
    private readonly security: SecurityEventsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http' || !this.turnstile.enabled) return true;
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_CAPTCHA,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['x-captcha-token'];
    const token = Array.isArray(header) ? header[0] : header;
    try {
      await this.turnstile.verify(token, req.ip);
    } catch (error) {
      this.security.record({
        type: 'captcha_failed',
        ip: req.ip ?? null,
        path: req.originalUrl,
        method: req.method,
        referer: req.headers['referer'] ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        details: { hadToken: !!token },
      });
      throw error;
    }
    return true;
  }
}
