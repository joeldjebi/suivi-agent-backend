import { IsDateString, IsOptional } from 'class-validator';

/** Période des statistiques des rayons (30 derniers jours par défaut). */
export class PhotoAiStatsQuery {
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Fin exclue */
  @IsOptional()
  @IsDateString()
  to?: string;
}
