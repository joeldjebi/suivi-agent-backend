import { DayStatus } from '@suivi/shared';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQuery } from '../common/pagination.dto';

export class DayHistoryQuery extends PaginationQuery {
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;

  /** Date de travail minimale (AAAA-MM-JJ) */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Date de travail maximale (AAAA-MM-JJ) */
  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsIn(Object.values(DayStatus))
  status?: DayStatus;
}
