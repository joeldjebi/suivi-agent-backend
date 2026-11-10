import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { SecurityEventsService } from './security-events.service';

/**
 * Chemins typiques des robots qui cherchent une faille (fichiers de secrets, panneaux
 * d'admin d'autres logiciels…). Aucun ne correspond à une page légitime de la plateforme.
 */
const SCANNER_PATTERNS: RegExp[] = [
  /(^|\/)\.(env|git|aws|ssh|svn|hg|htpasswd|DS_Store)(\/|$|\.)/i,
  /\/wp-(login\.php|admin|content|includes)/i,
  /\/xmlrpc\.php/i,
  /\/(phpmyadmin|phpMyAdmin|pma|adminer|dbadmin)/i,
  /\/(phpinfo|info|shell|cmd|eval)\.php/i,
  /\/(actuator|cgi-bin|boaform|HNAP1|solr|jenkins|server-status)(\/|$)/i,
  /\/vendor\/(phpunit|composer)/i,
  /\/\.well-known\/(?!acme-challenge|security\.txt)/i,
  /\/(owa|autodiscover)\//i,
];

/** Vrai si le chemin ressemble à une sonde de robot. */
export function isScannerPath(path: string): boolean {
  return SCANNER_PATTERNS.some((re) => re.test(path));
}

/**
 * Détecte les scans de chemins sensibles : si la requête vise un chemin typique de robot,
 * on le journalise (type « path_scan ») et on répond 404 sans aller plus loin. Monté très
 * tôt, avant le routage, pour couvrir tous les chemins (y compris hors /api relayés par Nginx).
 */
export function scanDetection(security: SecurityEventsService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isScannerPath(req.path)) return next();
    security.record({
      type: 'path_scan',
      ip: req.ip ?? null,
      path: req.originalUrl.slice(0, 500),
      method: req.method,
      referer: req.headers['referer'] ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      details: { matched: req.path.slice(0, 200) },
    });
    res.status(404).json({ statusCode: 404, code: 'NOT_FOUND' });
  };
}
