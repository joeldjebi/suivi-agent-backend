import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';
import type { AuthUser } from './auth-user';
import { RealtimeService } from './realtime.service';

/** Événement temps réel : « ces données ont changé, relisez-les ». */
export const SYNC_EVENT = 'sync';

/**
 * Écritures sans intérêt pour les autres appareils : connexion, profil, lecture des
 * notifications, appareils, photos envoyées avant leur formulaire, erreurs, assistance…
 */
const QUIET_TOPICS = new Set([
  'auth',
  'me',
  'notifications',
  'devices',
  'photos',
  'photo-ai',
  'client-errors',
  'support',
  'platform',
  'public',
]);

/**
 * Après chaque modification réussie (administrateur, chef ou agent), prévient tous les
 * appareils connectés de la structure, qui relisent l'écran concerné (missions, camion,
 * dépannages, points de vente, commandes…). Seul le sujet circule, jamais les données :
 * chacun les relit avec ses droits. Enveloppe la transaction : l'annonce part une fois les
 * données enregistrées. Les positions envoyées en continu ne sont pas annoncées.
 */
@Injectable()
export class SyncInterceptor implements NestInterceptor {
  constructor(private readonly realtime: RealtimeService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthUser | undefined;
    if (request.method === 'GET' || !user?.tenantId) return next.handle();

    // /api/missions/123/pay → « missions »
    const path = request.path.replace(/^\/api\//, '');
    const topic = path.split('/')[0];
    if (!topic || QUIET_TOPICS.has(topic) || path.includes('positions'))
      return next.handle();
    return next
      .handle()
      .pipe(tap(() => this.realtime.sync(user.tenantId, topic)));
  }
}
