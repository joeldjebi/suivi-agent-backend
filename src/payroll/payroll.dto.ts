import { PayPeriod } from '@suivi/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class PaySettingsDto {
  @IsIn(Object.values(PayPeriod))
  period: PayPeriod;
}

/** Grille : éléments (voir PayGridComponents) et cibles (rôles, groupes, agents). */
export class PayGridDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @IsObject()
  components: Record<string, unknown>;

  @IsObject()
  targets: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateRunDto {
  /** Une date de la période à calculer (période terminée) ; la précédente par défaut */
  @IsOptional()
  @IsDateString({ strict: true })
  date?: string;
}

export class AdjustmentDto {
  @IsUUID()
  userId: string;

  /** Positif (prime) ou négatif (retenue), dans la devise de la structure */
  @Type(() => Number)
  @IsInt()
  @Min(-10_000_000)
  @Max(10_000_000)
  amount: number;

  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;
}

export class DecisionDto {
  @IsBoolean()
  approve: boolean;
}

export class MarkPaidDto {
  /** Personnes payées (toutes par défaut) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  userIds?: string[];

  /** Référence du paiement (lot Mobile Money, virement…) */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
