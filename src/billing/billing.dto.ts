import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Filtres de la liste des agents actifs. Le total facturé, lui, porte toujours sur tout le mois. */
export class BillingQuery {
  /** AAAA-MM, mois en cours par défaut */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'Le mois doit être au format AAAA-MM',
  })
  month?: string;

  /** Agents du groupe */
  @IsOptional()
  @IsUUID()
  groupId?: string;

  /** Agents ayant travaillé au moins une journée dans cette zone pendant le mois */
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  /** Nom, prénom, email ou numéro */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  /** État du compte aujourd'hui */
  @IsOptional()
  @IsIn(['active', 'inactive'])
  account?: 'active' | 'inactive';

  /** Nombre minimum de journées travaillées dans le mois */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  minDays?: number;
}

export interface BillingAgent {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string;
  isActive: boolean;
  groupId: string | null;
  groupName: string | null;
  days: number;
  /** Temps travaillé dans le mois, pauses déduites (secondes) */
  workedSeconds: number;
  firstDay: string;
  lastDay: string;
  /** Zone où l'agent a le plus travaillé */
  mainZone: string | null;
  zones: number;
  /** Formulaires de mission envoyés dans le mois */
  forms: number;
  rejectedForms: number;
  /** Journées non terminées par l'agent, clôturées automatiquement */
  autoClosedDays: number;
}
