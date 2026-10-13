import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ACTIVITIES } from './setup.catalog';

/** Secteur choisi sur la carte : un point et un rayon. */
export class CustomAreaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;

  /** Rayon en mètres (200 m à 10 km) */
  @IsNumber()
  @Min(200)
  @Max(10_000)
  radiusM: number;
}

export class QuickAgentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  firstName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  lastName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone: string;
}

export class ApplySetupDto {
  /** Métiers (un ou plusieurs) : un formulaire et une mission de la semaine par métier */
  @IsArray()
  @ArrayMinSize(1, { message: 'Choisissez au moins un métier' })
  @ArrayMaxSize(ACTIVITIES.length)
  @IsIn(ACTIVITIES.map((a) => a.key), { each: true })
  activities: string[];

  /** Communes du catalogue (« abidjan:cocody ») */
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  areaKeys: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CustomAreaDto)
  customAreas?: CustomAreaDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => QuickAgentDto)
  agents?: QuickAgentDto[];

  /** Mot de passe de départ commun aux agents ajoutés (chacun le change ensuite) */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  agentPassword?: string;

  /** Première mission de la semaine (par défaut : oui) */
  @IsOptional()
  @IsBoolean()
  createMission?: boolean;
}
