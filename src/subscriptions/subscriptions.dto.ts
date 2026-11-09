import { BillingCycle, PLAN_CODE_PATTERN, type PlanCode } from '@suivi/shared';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ChangePlanDto {
  @IsOptional()
  @Matches(PLAN_CODE_PATTERN)
  planCode?: PlanCode;

  /** Annuel : engagement de 12 mois, remise sur chaque facture */
  @IsOptional()
  @IsIn(Object.values(BillingCycle))
  billingCycle?: BillingCycle;

  /** Agents achetés en plus du quota de la formule */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  extraAgents?: number;
}

/** Demande de mise en place : un forfait proposé par l'éditeur, et un message facultatif. */
export class OnboardingRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  packageCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}
