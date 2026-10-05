import { DayStatus } from '@suivi/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class PositionPointDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;

  /** Précision en mètres */
  @IsNumber()
  @Min(0)
  accuracy: number;

  /** Vitesse en m/s */
  @IsOptional()
  @IsNumber()
  speed?: number;

  /** Niveau de batterie entre 0 et 1 */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  batteryLevel?: number;

  /** Position simulée détectée sur le téléphone (Fake GPS) */
  @IsOptional()
  @IsBoolean()
  isMocked?: boolean;

  /** Heure de la mesure sur le téléphone (ISO 8601) */
  @IsDateString()
  recordedAt: string;
}

export class PositionBatchDto {
  @IsUUID()
  dayId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PositionPointDto)
  points: PositionPointDto[];
}

export class BatchResultDto {
  /** Points enregistrés */
  accepted: number;
  /** Points déjà reçus (renvoi après coupure réseau) */
  duplicates: number;
  /** Points hors de la journée ou pendant une pause non suivie */
  rejected: number;
}

export class LiveQuery {
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsOptional()
  @IsIn([DayStatus.Active, DayStatus.Paused])
  status?: DayStatus;
}
