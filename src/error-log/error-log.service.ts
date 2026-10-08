import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbService } from '../common/db.service';

export type ErrorSource = 'api' | 'web' | 'mobile';

export interface ErrorReport {
  source: ErrorSource;
  message: string;
  stack?: string | null;
  route?: string | null;
  appVersion?: string | null;
  tenantId?: string | null;
  userId?: string | null;
}

/** Erreurs gardées dans la liste (au-delà, les plus anciennes refermées sont oubliées). */
const MAX_ROWS = 2000;

/**
 * Journal des erreurs inattendues de toute la plateforme : une ligne par erreur identique
 * (même source, même écran ou route, même message aux nombres près), avec son nombre
 * d'occurrences et les structures touchées. Une erreur close qui revient est rouverte.
 */
@Injectable()
export class ErrorLogService {
  private readonly logger = new Logger(ErrorLogService.name);

  constructor(private readonly db: DbService) {}

  /** Empreinte : nombres et identifiants effacés, pour regrouper les mêmes erreurs. */
  static fingerprint(r: Pick<ErrorReport, 'source' | 'message' | 'route'>) {
    const normalize = (s: string) =>
      s
        .split('\n')[0]
        .replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          ':id',
        )
        .replace(/\d+/g, '#')
        .slice(0, 300);
    return createHash('sha1')
      .update(`${r.source}|${normalize(r.route ?? '')}|${normalize(r.message)}`)
      .digest('hex');
  }

  /** N'échoue jamais : le journal ne doit pas aggraver une panne. */
  async record(r: ErrorReport): Promise<void> {
    try {
      const message = (r.message || 'Erreur sans message').slice(0, 2000);
      await this.db.runAsSystem(() =>
        this.db.manager.query(
          `INSERT INTO platform_errors
             (fingerprint, source, message, route, stack, app_version, tenants, last_tenant_id, last_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::uuid IS NULL THEN '{}'::uuid[] ELSE ARRAY[$7::uuid] END, $7, $8)
           ON CONFLICT (fingerprint) DO UPDATE SET
             count = platform_errors.count + 1,
             message = EXCLUDED.message,
             stack = coalesce(EXCLUDED.stack, platform_errors.stack),
             app_version = coalesce(EXCLUDED.app_version, platform_errors.app_version),
             tenants = CASE
               WHEN EXCLUDED.last_tenant_id IS NULL
                 OR EXCLUDED.last_tenant_id = ANY(platform_errors.tenants)
                 OR cardinality(platform_errors.tenants) >= 50
               THEN platform_errors.tenants
               ELSE platform_errors.tenants || EXCLUDED.last_tenant_id END,
             last_tenant_id = coalesce(EXCLUDED.last_tenant_id, platform_errors.last_tenant_id),
             last_user_id = coalesce(EXCLUDED.last_user_id, platform_errors.last_user_id),
             last_seen_at = now(),
             resolved_at = NULL`,
          [
            ErrorLogService.fingerprint(r),
            r.source,
            message,
            r.route?.slice(0, 300) ?? null,
            r.stack?.slice(0, 8000) ?? null,
            r.appVersion?.slice(0, 40) ?? null,
            r.tenantId ?? null,
            r.userId ?? null,
          ],
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Journal des erreurs indisponible : ${(error as Error).message}`,
      );
    }
  }

  /** Liste de la console : en cours (par défaut) ou closes, par source. */
  list(status: 'open' | 'resolved' | 'all', source?: ErrorSource) {
    return this.db.runAsSystem(() =>
      this.db.manager.query<Record<string, unknown>[]>(
        `SELECT e.id, e.source, e.message, e.route, e.stack, e.app_version AS "appVersion",
                e.count, cardinality(e.tenants) AS "tenantCount",
                t.name AS "lastTenantName", e.last_tenant_id AS "lastTenantId",
                e.first_seen_at AS "firstSeenAt", e.last_seen_at AS "lastSeenAt",
                e.resolved_at AS "resolvedAt"
         FROM platform_errors e LEFT JOIN tenants t ON t.id = e.last_tenant_id
         WHERE ($1 = 'all' OR ($1 = 'open') = (e.resolved_at IS NULL))
           AND ($2::text IS NULL OR e.source = $2)
         ORDER BY e.last_seen_at DESC LIMIT 200`,
        [status, source ?? null],
      ),
    );
  }

  /** Résumé du tableau de bord : erreurs en cours, et survenues ces dernières 24 h. */
  async summary() {
    const [row] = await this.db.runAsSystem(() =>
      this.db.manager.query<{ open: number; lastDay: number }[]>(
        `SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
                count(*) FILTER (WHERE resolved_at IS NULL AND last_seen_at > now() - interval '24 hours')::int AS "lastDay"
         FROM platform_errors`,
      ),
    );
    return row;
  }

  /** Corrigée : retirée de la liste en cours (elle revient si elle se reproduit). */
  async resolve(id: string, resolved: boolean) {
    await this.db.runAsSystem(() =>
      this.db.manager.query(
        `UPDATE platform_errors SET resolved_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1`,
        [id, resolved],
      ),
    );
  }

  /** Ménage : au-delà de MAX_ROWS, les erreurs closes les plus anciennes sont oubliées. */
  async prune() {
    await this.db.runAsSystem(() =>
      this.db.manager.query(
        `DELETE FROM platform_errors WHERE id IN (
           SELECT id FROM platform_errors WHERE resolved_at IS NOT NULL
           ORDER BY last_seen_at DESC OFFSET $1)`,
        [MAX_ROWS],
      ),
    );
  }
}
