import { OnboardingStep } from '@suivi/shared';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

/** Étapes que l'administrateur valide lui-même. */
export const MANUAL_STEPS: OnboardingStep[] = [
  OnboardingStep.Prerequisites,
  OnboardingStep.Settings,
];

export class UpdateOnboardingDto {
  /** Étape à cocher ou décocher (uniquement les étapes manuelles) */
  @IsOptional()
  @IsIn(MANUAL_STEPS)
  step?: OnboardingStep;

  @IsOptional()
  @IsBoolean()
  done?: boolean;

  /** Masquer (ou réafficher) le guide */
  @IsOptional()
  @IsBoolean()
  dismissed?: boolean;
}
