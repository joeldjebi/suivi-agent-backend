import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class DailyReportQuery {
  /** Jour du bilan (AAAA-MM-JJ) ; aujourd'hui par défaut */
  @IsOptional()
  @IsDateString({ strict: true })
  date?: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;
}

export class TeamMessageDto {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  body: string;

  /** Destinataires choisis ; absents : toute l'équipe */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @Type(() => String)
  agentIds?: string[];
}
