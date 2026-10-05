import { DemoRequestStatus } from '@suivi/shared';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQuery } from '../common/pagination.dto';

/** Demande de démo envoyée depuis le site vitrine. */
export class DemoRequestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  organization: string;

  @IsEmail()
  @MaxLength(120)
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  agents?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;

  /** Champ piège invisible : rempli seulement par les robots. */
  @IsOptional()
  @IsString()
  website?: string;
}

export class SaveLandingDto {
  /** Contenu complet du site (vérifié champ par champ) */
  @IsObject()
  content: Record<string, unknown>;
}

export class ListDemoRequestsQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(Object.values(DemoRequestStatus))
  status?: DemoRequestStatus;
}

export class UpdateDemoRequestDto {
  @IsOptional()
  @IsIn(Object.values(DemoRequestStatus))
  status?: DemoRequestStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
