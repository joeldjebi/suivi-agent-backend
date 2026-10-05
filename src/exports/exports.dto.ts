import { SubmissionStatus } from '@suivi/shared';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';

export class ExportFormatQuery {
  /** xlsx (Excel, par défaut) ou csv */
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';
}

export class DaysExportQuery extends ExportFormatQuery {
  /** Premier jour (AAAA-MM-JJ), au plus un an avant `to` */
  @IsDateString({ strict: true })
  from: string;

  @IsDateString({ strict: true })
  to: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;

  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @IsUUID()
  zoneId?: string;
}

export class SubmissionsExportQuery extends ExportFormatQuery {
  /** Les formulaires d'une mission… */
  @IsOptional()
  @IsUUID()
  missionId?: string;

  /** …ou de toutes les missions d'un type (mêmes colonnes) */
  @IsOptional()
  @IsUUID()
  typeId?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @IsOptional()
  @IsIn(Object.values(SubmissionStatus))
  status?: SubmissionStatus;

  @IsOptional()
  @IsUUID()
  agentId?: string;
}
