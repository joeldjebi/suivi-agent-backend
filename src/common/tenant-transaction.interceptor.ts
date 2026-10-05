import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { from, lastValueFrom, Observable } from 'rxjs';
import type { AuthUser } from './auth-user';
import { DbService } from './db.service';

/** Ouvre une transaction par requête HTTP, limitée à la structure de l'utilisateur connecté. */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(private readonly db: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const user = context.switchToHttp().getRequest<Request>().user as
      AuthUser | undefined;
    const handle = () =>
      lastValueFrom(next.handle(), { defaultValue: undefined });
    return from(
      user
        ? this.db.runAsTenant(user.tenantId, handle)
        : this.db.runAsSystem(handle),
    );
  }
}
