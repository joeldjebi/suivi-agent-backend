import { PartialType } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateGroupDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  /** Chef d'équipe du groupe (rôle team_lead) */
  @IsOptional()
  @IsUUID()
  leaderId?: string | null;

  /** Durée de travail attendue par jour, en minutes (30 min à 24 h) ; null : celle du niveau au-dessus */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(30)
  @Max(1440)
  workdayMinutes?: number | null;
}

export class UpdateGroupDto extends PartialType(CreateGroupDto) {
  /** false = désactiver (réversible) ; true = réactiver */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetIdsDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids: string[];
}
