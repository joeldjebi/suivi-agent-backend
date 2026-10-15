import { OrderStatus } from '@suivi/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../common/pagination.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const STATUSES = Object.values(OrderStatus);

export class PriceListDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(trim)
  name: string;

  /** Appliqué aux points de vente sans type de client */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdatePriceListDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class PriceItemDto {
  @IsUUID()
  priceListId: string;

  @IsUUID()
  productId: string;

  /** Prix d'une unité de base ; null : pas de prix (produit non proposé à ce type de client) */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number | null;
}

export class SetPricesDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => PriceItemDto)
  items: PriceItemDto[];
}

export class CatalogQuery {
  /** Point de vente : son type de client décide des prix */
  @IsUUID()
  outletId: string;
}

export class OrderLineDto {
  @IsUUID()
  productId: string;

  /** En unités de base (bouteilles…) */
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity: number;
}

export class CreateOrderDto {
  /** Identifiant généré sur le téléphone : un renvoi ne crée pas de doublon */
  @IsUUID()
  clientId: string;

  @IsUUID()
  outletId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines: OrderLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;

  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  /** Heure de la prise sur le téléphone (commande saisie sans réseau) */
  @IsOptional()
  @IsDateString()
  takenAt?: string;
}

export class ChangeOrderStatusDto {
  @IsIn(STATUSES)
  status: OrderStatus;

  /** Motif (obligatoire pour une annulation) */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  comment?: string;
}

export class ListOrdersQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(STATUSES)
  status?: OrderStatus;

  @IsOptional()
  @IsUUID()
  outletId?: string;

  @IsOptional()
  @IsUUID()
  agentId?: string;

  /** Date de prise, incluse (AAAA-MM-JJ, heure de la structure) */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class OrdersSummaryQuery {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
