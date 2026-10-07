import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { catchError, throwError } from 'rxjs';
import type { AuthUser } from './auth-user';
import { captureError } from './monitoring';

/** Remonte les erreurs inattendues des requêtes à la supervision (Sentry). */
@Injectable()
export class MonitoringInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (context.getType() === 'http') {
          const req = context
            .switchToHttp()
            .getRequest<Request & { user?: AuthUser }>();
          captureError(error, {
            route: `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`,
            tenantId: req.user?.tenantId ?? null,
            userId: req.user?.id,
          });
        }
        return throwError(() => error);
      }),
    );
  }
}
