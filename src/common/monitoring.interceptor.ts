import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { catchError, throwError } from 'rxjs';
import type { AuthUser } from './auth-user';
import { ErrorLogService } from '../error-log/error-log.service';
import { captureError, isUnexpected } from './monitoring';

/** Remonte les erreurs inattendues des requêtes à la supervision (Sentry). */
@Injectable()
export class MonitoringInterceptor implements NestInterceptor {
  constructor(private readonly errors: ErrorLogService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (context.getType() === 'http') {
          const req = context
            .switchToHttp()
            .getRequest<Request & { user?: AuthUser }>();
          const route = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
          captureError(error, {
            route,
            tenantId: req.user?.tenantId ?? null,
            userId: req.user?.id,
          });
          // Journal de la console éditeur, avec ou sans Sentry.
          if (isUnexpected(error)) {
            void this.errors.record({
              source: 'api',
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? (error.stack ?? null) : null,
              route,
              tenantId: req.user?.tenantId ?? null,
              userId: req.user?.id ?? null,
            });
          }
        }
        return throwError(() => error);
      }),
    );
  }
}
