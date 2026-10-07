import { AlertType } from '@suivi/shared';
import {
  IsDateString,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListAlertsQuery {
  /** open (par défaut) : en cours ; resolved : refermées ; all : toutes */
  @IsOptional()
  @IsIn(['open', 'resolved', 'all'])
  status?: 'open' | 'resolved' | 'all';

  @IsOptional()
  @IsIn(Object.values(AlertType))
  type?: AlertType;

  @IsOptional()
  @IsUUID()
  agentId?: string;

  /** Alertes ouvertes à partir de cette date */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class AcknowledgeDto {
  /** Ce qui a été fait (appel, message…) */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** Alerte sécurité de l'agent : sa position et un message facultatif. */
export class RaiseSosDto {
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  /** Précision de la position, en mètres */
  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracy?: number;

  /** Batterie du téléphone, de 0 à 1 */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  battery?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  message?: string;
}

export class CloseAlertDto {
  /** Comment la situation s'est réglée */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
