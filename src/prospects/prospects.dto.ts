import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const PROSPECT_STATUTS = [
  'a_contacter',
  'contacte',
  'relance',
  'interesse',
  'rdv',
  'gagne',
  'perdu',
] as const;

export class ListProspectsDto {
  @IsOptional()
  @IsIn(PROSPECT_STATUTS)
  statut?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  pays?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class SaveProspectDto {
  @IsString()
  @MaxLength(200)
  entreprise: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  secteur?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  pays?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  ville?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactNom?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  telephone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  canal?: string | null;

  @IsOptional()
  @IsIn(PROSPECT_STATUTS)
  statut?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class UpdateProspectDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  entreprise?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  secteur?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  pays?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  ville?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactNom?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  telephone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  canal?: string | null;

  @IsOptional()
  @IsIn(PROSPECT_STATUTS)
  statut?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  objet?: string | null;

  @IsString()
  @MaxLength(6000)
  corps: string;
}
