import { HttpException } from '@nestjs/common';
import * as Sentry from '@sentry/node';

/**
 * Supervision des erreurs (Sentry) : active seulement si SENTRY_DSN est renseigné. Seules
 * les erreurs inattendues (500) partent, sans données personnelles : ni jeton, ni cookie,
 * ni corps de requête.
 */
let enabled = false;

export function initMonitoring() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.APP_VERSION,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        const headers = event.request.headers ?? {};
        for (const name of Object.keys(headers)) {
          if (/authorization|cookie|token/i.test(name)) delete headers[name];
        }
      }
      return event;
    },
  });
  enabled = true;
}

/** Panne ou bug (les refus métier et les 4xx sont des réponses normales). */
export function isUnexpected(error: unknown): boolean {
  return !(error instanceof HttpException) || error.getStatus() >= 500;
}

/** Erreur inattendue : envoyée à Sentry (les refus métier et les 4xx ne le sont pas). */
export function captureError(
  error: unknown,
  context: { route?: string; tenantId?: string | null; userId?: string } = {},
) {
  if (!enabled) return;
  if (error instanceof HttpException && error.getStatus() < 500) return;
  Sentry.withScope((scope) => {
    if (context.route) scope.setTag('route', context.route);
    if (context.tenantId) scope.setTag('tenant', context.tenantId);
    // Identifiant technique seulement (pas de nom, pas d'email).
    if (context.userId) scope.setUser({ id: context.userId });
    Sentry.captureException(error);
  });
}
