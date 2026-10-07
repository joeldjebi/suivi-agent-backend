import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { DbService } from '../common/db.service';
import { Public } from '../common/decorators';
import { PlatformSettings } from '../entities';

/** 426 : mise à jour nécessaire (absent de HttpStatus). */
const UPGRADE_REQUIRED = 426;

export interface AppVersionInfo {
  minVersion: string | null;
  latestVersion: string | null;
  androidUrl: string | null;
  iosUrl: string | null;
}

/** 1.10.0 > 1.9.3 : comparaison numérique, partie par partie. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Réglages de version, relus au plus toutes les 30 secondes. */
@Injectable()
export class AppVersionService {
  private cache: { at: number; info: AppVersionInfo } | null = null;

  constructor(private readonly db: DbService) {}

  async info(): Promise<AppVersionInfo> {
    if (this.cache && Date.now() - this.cache.at < 30_000)
      return this.cache.info;
    const s = await this.db.runAsSystem(() =>
      this.db.manager.findOneByOrFail(PlatformSettings, { id: 1 }),
    );
    const info = {
      minVersion: s.minAppVersion,
      latestVersion: s.latestAppVersion,
      androidUrl: s.androidStoreUrl,
      iosUrl: s.iosStoreUrl,
    };
    this.cache = { at: Date.now(), info };
    return info;
  }

  invalidate() {
    this.cache = null;
  }
}

@ApiTags('Santé')
@Controller('app')
export class AppVersionController {
  constructor(private readonly versions: AppVersionService) {}

  /** Version minimale et dernière version de l'app mobile, liens de téléchargement. */
  @Public()
  @Get('version')
  version() {
    return this.versions.info();
  }
}

/**
 * App mobile trop ancienne : toutes ses requêtes sont refusées (426) avec le lien de mise à
 * jour. L'app s'annonce par « X-App-Version » ; une ancienne version sans cet en-tête est
 * reconnue à son agent HTTP (Dart). Le site web n'est jamais concerné.
 */
@Injectable()
export class AppVersionGuard implements CanActivate {
  constructor(private readonly versions: AppVersionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (/\/(health|app\/version)$/.test(req.path)) return true;
    const header = req.header('x-app-version');
    const dart = /^Dart\//.test(req.header('user-agent') ?? '');
    if (!header && !dart) return true;
    const { minVersion, androidUrl, iosUrl } = await this.versions.info();
    if (!minVersion) return true;
    const version = header ?? '0.0.0';
    if (compareVersions(version, minVersion) >= 0) return true;
    const ios = /ios/i.test(req.header('x-app-platform') ?? '');
    throw new HttpException(
      {
        statusCode: UPGRADE_REQUIRED,
        code: 'APP_UPDATE_REQUIRED',
        message:
          'Une nouvelle version de l’application est nécessaire. Mettez-la à jour pour continuer.',
        minVersion,
        storeUrl: ios ? iosUrl : androidUrl,
      },
      UPGRADE_REQUIRED,
    );
  }
}
