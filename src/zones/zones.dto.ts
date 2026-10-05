import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class PolygonDto {
  @IsIn(['Polygon'])
  type: 'Polygon';

  /** Anneaux GeoJSON en [longitude, latitude] ; le premier point est répété à la fin */
  @IsArray()
  coordinates: number[][][];
}

export class CreateZoneDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  /** Polygone dessiné sur la carte (GeoJSON, WGS 84) */
  @ValidateNested()
  @Type(() => PolygonDto)
  area: PolygonDto;

  /** Nombre maximum d'agents (RG-02) ; vide = illimité */
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number | null;

  /** Zone sensible : approbation manuelle en mode mixte (RG-23) */
  @IsOptional()
  @IsBoolean()
  sensitive?: boolean;

  /** Sans groupes : zone réservée aux agents autorisés (RG-15) */
  @IsOptional()
  @IsBoolean()
  restricted?: boolean;
}

export class UpdateZoneDto extends PartialType(CreateZoneDto) {
  /** false = fermer la zone (ses places sont libérées) ; true = la rouvrir */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
