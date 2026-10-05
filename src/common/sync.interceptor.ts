import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Role } from '@suivi/shared';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';
import type { AuthUser } from './auth-user';
import { RealtimeService, rooms } from './realtime.service';

/** Événement temps réel : « ces données ont changé, relisez-les ». */
export const SYNC_EVENT = 'sync';

/**
 * Après chaque modification réussie d'un administrateur ou d'un chef d'équipe, prévient tous
 * les appareils connectés de la structure, qui relisent l'écran concerné (missions, zones,
 * groupes…). Seul le sujet circule, jamais les données : chacun les relit avec ses droits.
 * Enveloppe la transaction : l'annonce part une fois les données enregistrées.
 */
@Injectable()
export class SyncInterceptor implements NestInterceptor {
  constructor(private readonly realtime: RealtimeService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthUser | undefined;
    if (
      request.method === 'GET' ||
      !user ||
      (user.role !== Role.Admin && user.role !== Role.TeamLead)
    )
      return next.handle();

    // /api/missions/123/pay → « missions »
    const topic = request.path.replace(/^\/api\//, '').split('/')[0];
    return next.handle().pipe(
      tap(() => {
        if (topic)
          this.realtime.emit([rooms.tenant(user.tenantId)], SYNC_EVENT, {
            topic,
          });
      }),
    );
  }
}
