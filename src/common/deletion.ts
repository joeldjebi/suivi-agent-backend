import { HttpStatus } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { BusinessException } from './business.exception';

/**
 * Données liées qu'une suppression définitive emporterait, par type.
 * Exemple : `{ missions: 3, agents: 12 }`.
 */
export type Impact = Record<string, number>;

export class DeleteQuery {
  /** Confirme la suppression définitive malgré les données liées (cascade) */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  force?: boolean;
}

export class ImpactDto {
  /** Nombre d'éléments liés, par type */
  impact: Impact;
  /** Vrai si la suppression doit être confirmée par `force=true` */
  requiresForce: boolean;
}

export function describeImpact(impact: Impact): ImpactDto {
  return { impact, requiresForce: Object.values(impact).some((n) => n > 0) };
}

/**
 * Suppression définitive : refusée tant que des données liées existent,
 * sauf confirmation explicite. La désactivation reste l'action recommandée.
 */
export function assertDeletable(impact: Impact, force: boolean | undefined) {
  if (force || !describeImpact(impact).requiresForce) return;
  throw new BusinessException(
    HttpStatus.CONFLICT,
    'HAS_DEPENDENCIES',
    'Des données sont liées à cet élément. Désactivez-le, ou confirmez la suppression définitive.',
    { impact },
  );
}

/** Compte des lignes liées, en une requête. */
export const countSql = (table: string, column: string) =>
  `(SELECT count(*)::int FROM ${table} WHERE ${column} = $1)`;
