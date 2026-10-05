import { OnboardingAnimation } from '@suivi/shared';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateSlideDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  title: string;

  @IsString()
  @MinLength(2)
  @MaxLength(220)
  body: string;

  @IsIn(Object.values(OnboardingAnimation))
  animation: OnboardingAnimation;

  /** Couleur d'accent #RRGGBB ; null : couleur de l'app */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Couleur au format #RRGGBB' })
  color?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateSlideDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(220)
  body?: string;

  @IsOptional()
  @IsIn(Object.values(OnboardingAnimation))
  animation?: OnboardingAnimation;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Couleur au format #RRGGBB' })
  color?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ReorderSlidesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @IsUUID('4', { each: true })
  ids: string[];
}

export class OnboardingSettingsDto {
  @IsBoolean()
  enabled: boolean;
}
