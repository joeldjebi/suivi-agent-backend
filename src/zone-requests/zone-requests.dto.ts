import { ZoneRequestStatus } from '@suivi/shared';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQuery } from '../common/pagination.dto';

export class CreateZoneRequestDto {
  @IsUUID()
  zoneId: string;
}

export class DecideZoneRequestDto {
  @IsBoolean()
  approve: boolean;

  /** Motif, notamment en cas de refus */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReassignDto {
  @IsUUID()
  agentId: string;

  @IsUUID()
  zoneId: string;

  /** Administrateur uniquement : dépasser la capacité de la zone (RG-32) */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class ListZoneRequestsQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(Object.values(ZoneRequestStatus))
  status?: ZoneRequestStatus;

  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @IsUUID()
  zoneId?: string;
}
