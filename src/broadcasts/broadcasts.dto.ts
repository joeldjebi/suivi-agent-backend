import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const BROADCAST_TARGETS = [
  'all',
  'agents',
  'leads',
  'users',
  'zones',
  'missions',
] as const;
export type BroadcastTarget = (typeof BROADCAST_TARGETS)[number];

/** À qui envoyer : tout le monde, un rôle, des personnes, des zones ou des missions. */
export class BroadcastAudienceDto {
  @IsIn(BROADCAST_TARGETS)
  target: BroadcastTarget;

  /** Personnes choisies (agents ou chefs d'équipe) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  userIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  zoneIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  missionIds?: string[];

  /** Zones et missions : ajoute les chefs des groupes concernés */
  @IsOptional()
  @IsBoolean()
  includeLeads?: boolean;
}

export class BroadcastPreviewDto {
  @ValidateNested()
  @Type(() => BroadcastAudienceDto)
  audience: BroadcastAudienceDto;
}

export class SendBroadcastDto extends BroadcastPreviewDto {
  @IsString()
  @MinLength(2)
  @MaxLength(65)
  title: string;

  @IsString()
  @MinLength(2)
  @MaxLength(500)
  body: string;
}
