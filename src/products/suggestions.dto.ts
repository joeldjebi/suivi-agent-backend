import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PackagingDto } from './products.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** Produit concurrent vu sur le terrain. */
export class CreateSuggestionDto {
  /** Identifiant généré sur le téléphone : un renvoi ne crée pas de doublon */
  @IsUUID()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  brand?: string;

  /** « 33 cl », « 1 kg » */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(trim)
  format?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  category?: string;

  /** Point de vente où le produit a été vu */
  @IsOptional()
  @IsUUID()
  outletId?: string;

  /** Photo prise avec l'app (POST /photos) */
  @IsOptional()
  @IsUUID()
  photoId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}

export class ListSuggestionsQuery {
  @IsOptional()
  @IsIn(SUGGESTION_STATUSES)
  status?: SuggestionStatus;
}

/**
 * Acceptation : ajout au catalogue comme produit concurrent (nom, format… corrigés au besoin,
 * unité et conditionnements), ou rattachement à un produit existant (`productId`, doublon).
 */
export class AcceptSuggestionDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(trim)
  format?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  category?: string;

  /** Unité de base (Bouteille par défaut) */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Transform(trim)
  unit?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => PackagingDto)
  packagings?: PackagingDto[];
}

export class RejectSuggestionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Transform(trim)
  reason: string;
}
