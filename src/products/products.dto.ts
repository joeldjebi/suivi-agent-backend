import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class PackagingDto {
  /** « Casier », « Carton »… */
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  @Transform(trim)
  name: string;

  /** Nombre d'unités de base dans un conditionnement */
  @IsInt()
  @Min(2)
  @Max(100_000)
  units: number;
}

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  brand?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  category?: string | null;

  /** « 33 cl », « 1 kg » */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(trim)
  format?: string | null;

  /** Produit de la structure ; false : produit concurrent */
  @IsBoolean()
  own: boolean;

  /** Unité de base : bouteille, sachet, kg… */
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Transform(trim)
  unit: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => PackagingDto)
  packagings?: PackagingDto[];
}

export class UpdateProductDto extends PartialType(CreateProductDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListProductsQuery {
  /** own, competitor */
  @IsOptional()
  @IsString()
  side?: 'own' | 'competitor';

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
