import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { AuditLog } from '../entities';
import type { AuthUser } from './auth-user';
import { DbService } from './db.service';

/** Journal des accès (section 8) : toutes les requêtes qui modifient des données. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly db: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method === 'GET') return next.handle();

    const write = (statusCode: number) => {
      const user = request.user as AuthUser | undefined;
      if (!user) return; // la connexion est journalisée par le service d'authentification
      const entry = {
        tenantId: user.tenantId,
        userId: user.id,
        action: `${context.getClass().name}.${context.getHandler().name}`,
        method: request.method,
        path: request.originalUrl,
        statusCode,
        ip: request.ip ?? null,
      };
      this.db
        .runAsTenant(user.tenantId, () =>
          this.db.manager.insert(AuditLog, entry),
        )
        .catch((error) =>
          this.logger.error('Échec du journal des accès', error),
        );
    };

    return next.handle().pipe(
      tap({
        next: () =>
          write(context.switchToHttp().getResponse<Response>().statusCode),
        error: (error: { status?: number }) => write(error.status ?? 500),
      }),
    );
  }
}
