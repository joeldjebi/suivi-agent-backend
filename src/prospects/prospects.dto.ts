import {
  IsBoolean,
  IsDateString,
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
  'a_relancer',
  'rdv',
  'demo',
  'client',
  'pas_interesse',
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

class ProspectFields {
  @IsOptional() @IsString() @MaxLength(120) secteur?: string | null;
  @IsOptional() @IsString() @MaxLength(80) pays?: string | null;
  @IsOptional() @IsString() @MaxLength(120) ville?: string | null;
  @IsOptional() @IsString() @MaxLength(160) contactNom?: string | null;
  @IsOptional() @IsString() @MaxLength(60) telephone?: string | null;
  @IsOptional() @IsString() @MaxLength(200) email?: string | null;
  @IsOptional() @IsString() @MaxLength(60) canal?: string | null;
  @IsOptional() @IsString() @MaxLength(300) site?: string | null;
  @IsOptional() @IsString() @MaxLength(300) facebook?: string | null;
  @IsOptional() @IsString() @MaxLength(300) instagram?: string | null;
  @IsOptional() @IsString() @MaxLength(300) linkedin?: string | null;
  @IsOptional() @IsBoolean() prioritaire?: boolean;
  @IsOptional() @IsIn(PROSPECT_STATUTS) statut?: string;
  @IsOptional() @IsDateString() prochaineActionDate?: string | null;
  @IsOptional() @IsString() @MaxLength(500) prochaineActionNote?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}

export class SaveProspectDto extends ProspectFields {
  @IsString()
  @MaxLength(200)
  entreprise: string;
}

export class UpdateProspectDto extends ProspectFields {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  entreprise?: string;
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
