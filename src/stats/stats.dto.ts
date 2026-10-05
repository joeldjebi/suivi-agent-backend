import { IsDateString, IsOptional, IsUUID } from 'class-validator';

/** Période (dates de la structure, incluses ; 30 derniers jours par défaut) ; groupe, agent et zone facultatifs. */
export class StatsQuery {
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;

  /** Un seul agent */
  @IsOptional()
  @IsUUID()
  agentId?: string;

  /** Journées passées dans cette zone */
  @IsOptional()
  @IsUUID()
  zoneId?: string;
}
