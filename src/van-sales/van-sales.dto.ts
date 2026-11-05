import { PaymentMethod, StockLocationKind } from '@suivi/shared';
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../common/pagination.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const METHODS = Object.values(PaymentMethod);

// ------------------------------------------------------------ emplacements

export class CreateLocationDto {
  @IsIn(Object.values(StockLocationKind))
  kind: StockLocationKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(trim)
  name: string;

  /** Immatriculation (camion) */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  plate?: string | null;

  /** Agent vendeur (camion) ; null : aucun */
  @IsOptional()
  @IsUUID()
  agentId?: string | null;
}

export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  plate?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  agentId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ------------------------------------------------------------ mouvements

export class StockLineDto {
  @IsUUID()
  productId: string;

  /** En unités de base */
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity: number;
}

class StockLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StockLineDto)
  lines: StockLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}

/** Entrée au dépôt (livraison du fournisseur, production). */
export class ReceiptDto extends StockLinesDto {
  @IsUUID()
  depotId: string;
}

/** Chargement d'un camion depuis un dépôt, à confirmer par l'agent. */
export class LoadDto extends StockLinesDto {
  @IsUUID()
  depotId: string;

  @IsUUID()
  vanId: string;
}

/** Retour au dépôt déclaré par l'agent, à confirmer par un responsable. */
export class UnloadDto extends StockLinesDto {
  @IsUUID()
  clientId: string;

  @IsUUID()
  depotId: string;

  /** Camion : celui de l'agent par défaut */
  @IsOptional()
  @IsUUID()
  vanId?: string;
}

/** Casse, perte, vol, produit périmé (motif obligatoire). */
export class LossDto {
  @IsUUID()
  clientId: string;

  /** Emplacement : le camion de l'agent par défaut */
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StockLineDto)
  lines: StockLineDto[];

  /** Motif : casse, vol, périmé… */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Transform(trim)
  note: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}

export class ReceivedLineDto {
  @IsUUID()
  productId: string;

  /** Quantité réellement reçue, en unités de base */
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  received: number;
}

/** Confirmation d'un chargement ou d'un retour ; sans lignes : tout reçu. */
export class ConfirmMovementDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceivedLineDto)
  lines?: ReceivedLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}

export class CountedLineDto {
  @IsUUID()
  productId: string;

  /** Quantité comptée, en unités de base */
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  counted: number;
}

/** Inventaire d'un emplacement : les quantités comptées remplacent le stock. */
export class InventoryDto {
  @IsUUID()
  locationId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CountedLineDto)
  lines: CountedLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}

export class CancelDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Transform(trim)
  reason: string;
}

export class MovementsQuery extends PaginationQuery {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsString()
  kind?: string;

  @IsOptional()
  @IsIn(['pending', 'done', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

// ------------------------------------------------------------ ventes et paiements

export class SaleLineDto {
  @IsUUID()
  productId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity: number;
}

/** Vente directe depuis le camion : livrée sur place, payée en tout ou partie. */
export class CreateSaleDto {
  /** Identifiant généré sur le téléphone : un renvoi ne crée pas de doublon */
  @IsUUID()
  clientId: string;

  @IsUUID()
  outletId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines: SaleLineDto[];

  /** Montant payé sur place ; le reste est à crédit */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  paidAmount: number;

  /** Moyen de paiement du montant payé (obligatoire s'il y a un paiement) */
  @IsOptional()
  @IsIn(METHODS)
  paymentMethod?: PaymentMethod;

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

  /** Heure de la vente sur le téléphone (vente saisie sans réseau) */
  @IsOptional()
  @IsDateString()
  soldAt?: string;
}

/** Paiement reçu d'un client : il règle ses commandes dues, les plus anciennes d'abord. */
export class CreatePaymentDto {
  @IsUUID()
  clientId: string;

  @IsUUID()
  outletId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  amount: number;

  @IsIn(METHODS)
  method: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;

  @IsOptional()
  @IsDateString()
  receivedAt?: string;
}

export class CreditLimitDto {
  /** Plafond de crédit ; null : pas de vente à crédit */
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  limit: number | null;
}

// ------------------------------------------------------------ caisse

export class CashQuery {
  /** Jour (AAAA-MM-JJ, heure de la structure) ; aujourd'hui par défaut */
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsUUID()
  agentId?: string;
}

export class RemittanceDto {
  @IsUUID()
  agentId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}
