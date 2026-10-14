import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Période (dates de la structure, incluses ; 30 derniers jours par défaut) et filtres. */
export class InsightsQuery {
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  /** Points de vente de cette zone */
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  /** own : nos produits ; competitor : la concurrence */
  @IsOptional()
  @IsIn(['own', 'competitor'])
  side?: 'own' | 'competitor';

  @IsOptional()
  @IsUUID()
  productId?: string;
}
