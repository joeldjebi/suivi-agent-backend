import { AlertType } from '@suivi/shared';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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
