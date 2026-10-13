import { OutletStatus } from '@suivi/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../common/pagination.dto';
import { MissionFieldDto } from '../missions/missions.dto';

const STATUSES = Object.values(OutletStatus);
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Informations de base d'un point de vente (hors position). */
class OutletInfoDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  category?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  managerName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  /** Repère pour le retrouver : « en face de la pharmacie », « marché, allée 3 » */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  landmark?: string | null;

  /** Photo de la devanture (envoyée d'abord par POST /photos) */
  @IsOptional()
  @IsUUID()
  photoId?: string | null;

  /** Réponses aux champs de la fiche définis par la structure */
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

export class CreateOutletDto extends OutletInfoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  name: string;

  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;

  /** Précision du GPS en mètres */
  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracy?: number;

  @IsOptional()
  @IsIn(STATUSES)
  status?: OutletStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;

  /** Identifiant donné par le téléphone (envoi hors ligne sans doublon) */
  @IsOptional()
  @IsUUID()
  clientId?: string;

  /** Créer malgré un point de vente semblable tout proche */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class UpdateOutletDto extends OutletInfoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  name?: string;

  /** Position : l'administrateur et le chef la corrigent ; l'agent ne fait que localiser un point de vente qui n'en a pas. */
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracy?: number;
}

export class ChangeOutletStatusDto {
  @IsIn(STATUSES)
  status: OutletStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  comment?: string;
}

export class MergeOutletDto {
  /** Point de vente conservé : celui-ci y est fusionné puis supprimé */
  @IsUUID()
  intoId: string;
}

export class OutletFieldsDto {
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => MissionFieldDto)
  fields: MissionFieldDto[];
}

export class ListOutletsQuery extends PaginationQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: OutletStatus;

  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  /** Sans position (importés, à localiser) */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unlocated?: boolean;

  /** Autour d'un point : triés du plus proche au plus loin */
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  /** Rayon en mètres autour de lat/lng */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(10)
  @Max(50_000)
  radius?: number;
}

export class OutletsMapQuery {
  @IsOptional()
  @IsIn(STATUSES)
  status?: OutletStatus;

  @IsOptional()
  @IsUUID()
  zoneId?: string;
}

export class ExportOutletsQuery extends OutletsMapQuery {
  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';
}
