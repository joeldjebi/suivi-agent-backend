import { PartialType } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateGroupDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  /** Chef d'équipe du groupe (rôle team_lead) */
  @IsOptional()
  @IsUUID()
  leaderId?: string | null;
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
