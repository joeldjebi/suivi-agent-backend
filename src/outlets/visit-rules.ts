import { HttpStatus } from '@nestjs/common';
import { BusinessException, badRequest } from '../common/business.exception';
import { haversine } from './route';

/**
 * Règles communes à toute visite d'un point de vente (libre ou dans une mission) : l'agent
 * doit être sur place, à la distance réglée par la structure (0 = pas de contrôle), la
 * précision du GPS tolérée jusqu'à 25 m. Renvoie la distance mesurée (null : non mesurable).
 */
export function assertPresence(
  outlet: { name: string; lat: number | null; lng: number | null },
  at: { lat?: number | null; lng?: number | null; accuracy?: number | null },
  radius: number,
): number | null {
  const hasPosition = at.lat != null && at.lng != null;
  if (radius > 0 && !hasPosition)
    throw badRequest(
      'POSITION_REQUIRED',
      'Position introuvable : activez la localisation pour enregistrer la visite',
    );
  if (!hasPosition || outlet.lat == null || outlet.lng == null) return null;
  const distance = Math.round(
    haversine(
      { lat: at.lat!, lng: at.lng! },
      { lat: outlet.lat, lng: outlet.lng },
    ),
  );
  const tolerance = Math.min(at.accuracy ?? 0, 25);
  if (radius > 0 && distance > radius + tolerance)
    throw new BusinessException(
      HttpStatus.CONFLICT,
      'VISIT_TOO_FAR',
      `Vous êtes à ${distance} m de « ${outlet.name} » : rapprochez-vous (${radius} m au plus)`,
      { distance, radius },
    );
  return distance;
}
