import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ArrayUnique,
  IsArray,
  Max,
  MaxLength,
  Min,
  MinLength,
  IsUrl,
  ValidateIf,
} from 'class-validator';
import {
  BillingCycle,
  Feature,
  InvoiceStatus,
  PLAN_CODE_PATTERN,
  SubscriptionStatus,
  type PlanCode,
} from '@suivi/shared';
import { PaginationQuery } from '../common/pagination.dto';

export class PlatformLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

/** Deuxième étape de connexion : code de l'application d'authentification ou code de secours. */
export class PlatformMfaLoginDto {
  @IsString()
  @IsNotEmpty()
  mfaToken: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  code: string;
}

export class MfaCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  code: string;
}

export class MfaDisableDto {
  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  code: string;
}

export class PlatformPasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @MinLength(10)
  newPassword: string;
}

export class CreatePlatformAdminDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @IsString()
  @MinLength(10)
  password: string;
}

export class UpdatePlatformAdminDto {
  @IsBoolean()
  isActive: boolean;
}

export class ListTenantsQuery extends PaginationQuery {
  /** Nom de la structure, email ou téléphone de son administrateur */
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(Object.values(SubscriptionStatus))
  status?: SubscriptionStatus;

  @IsOptional()
  @Matches(PLAN_CODE_PATTERN)
  planCode?: PlanCode;

  /** Factures échues non payées */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  overdue?: boolean;

  @IsOptional()
  @IsIn(['name', 'created', 'agents', 'mrr', 'activity'])
  sort?: 'name' | 'created' | 'agents' | 'mrr' | 'activity';
}

/** Création d'une structure par l'éditeur (démarche commerciale). */
export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  organizationName: string;

  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @IsEmail()
  email: string;

  /** Mot de passe provisoire remis à l'administrateur de la structure */
  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  /** Sans formule : essai gratuit. Avec : cliente directement, sans essai. */
  @IsOptional()
  @Matches(PLAN_CODE_PATTERN)
  planCode?: PlanCode;

  @IsOptional()
  @IsIn(Object.values(BillingCycle))
  billingCycle?: BillingCycle;
}

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;
}

/**
 * Abonnement modifié par l'éditeur : formule, cycle, agents supplémentaires, conditions
 * négociées (null : celles de la formule), fin d'essai. Pas de blocage de rétrogradation :
 * les dépassements sont signalés dans la réponse.
 */
export class PlatformSubscriptionDto {
  @IsOptional()
  @Matches(PLAN_CODE_PATTERN)
  planCode?: PlanCode;

  @IsOptional()
  @IsIn(Object.values(BillingCycle))
  billingCycle?: BillingCycle;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  extraAgents?: number;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  customMonthlyPrice?: number | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  customIncludedAgents?: number | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  customIncludedLeads?: number | null;

  /** Prolonge (ou écourte) l'essai ; seulement pendant l'essai */
  @IsOptional()
  @IsDateString()
  trialEndsAt?: string;
}

export class SuspendDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export const PaymentMethod = {
  MobileMoney: 'mobile_money',
  Transfer: 'transfer',
  Cash: 'cash',
  Other: 'other',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export class ListInvoicesQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(Object.values(InvoiceStatus))
  status?: InvoiceStatus;

  @IsOptional()
  @IsUUID()
  tenantId?: string;

  /** Mois facturé, AAAA-MM */
  @IsOptional()
  @IsString()
  month?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  overdue?: boolean;

  /** Numéro de facture ou nom de la structure */
  @IsOptional()
  @IsString()
  search?: string;
}

export class RecordPaymentDto {
  @IsIn(Object.values(PaymentMethod))
  method: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  /** Date du paiement (par défaut : maintenant) */
  @IsOptional()
  @IsDateString()
  paidAt?: string;
}

export class VoidInvoiceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/** Nouvelle formule du catalogue. */
export class CreatePlanDto {
  /** Identifiant définitif : minuscules, chiffres et tirets (ex. « entreprise-plus ») */
  @Matches(PLAN_CODE_PATTERN, {
    message: 'Code : 2 à 30 caractères, minuscules, chiffres et tirets',
  })
  code: PlanCode;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name: string;

  @IsString()
  @MaxLength(300)
  description: string;

  @IsInt()
  @Min(0)
  monthlyPrice: number;

  @IsInt()
  @Min(0)
  includedAgents: number;

  @IsInt()
  @Min(0)
  includedLeads: number;

  @IsInt()
  @Min(0)
  extraAgentPrice: number;

  /** Avantages inclus (fonctionnalités de l'application) */
  @IsArray()
  @ArrayUnique()
  @IsIn(Object.values(Feature), { each: true })
  features: Feature[];

  @IsOptional()
  @IsInt()
  @Min(0)
  sort?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  includedAgents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  includedLeads?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  extraAgentPrice?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(Object.values(Feature), { each: true })
  features?: Feature[];

  @IsOptional()
  @IsInt()
  @Min(0)
  sort?: number;
}

export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  trialDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  annualDiscountPercent?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  invoiceDueDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  suspendAfterDays?: number;

  /** Formule dont l'essai gratuit prend les quotas */
  @IsOptional()
  @Matches(PLAN_CODE_PATTERN)
  trialPlanCode?: PlanCode;

  /** Formule attribuée aux nouvelles structures, active à la fin de l'essai */
  @IsOptional()
  @Matches(PLAN_CODE_PATTERN)
  defaultPlanCode?: PlanCode;

  /** App mobile : version minimale (x.y.z), vide pour ne rien imposer */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'Version au format 1.2.0' })
  minAppVersion?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'Version au format 1.2.0' })
  latestAppVersion?: string | null;

  /** Lien de téléchargement Android (Play Store ou fichier APK) */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUrl({ require_protocol: true })
  androidStoreUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUrl({ require_protocol: true })
  iosStoreUrl?: string | null;
}

export class TenantUsersQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(['admin', 'team_lead', 'agent'])
  role?: 'admin' | 'team_lead' | 'agent';

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';

  /** Nom, email ou numéro */
  @IsOptional()
  @IsString()
  search?: string;
}

export class TenantActivityQuery extends PaginationQuery {
  /** Connexions, modifications, ou échecs seulement */
  @IsOptional()
  @IsIn(['logins', 'changes', 'failed'])
  kind?: 'logins' | 'changes' | 'failed';
}

export class AuditQuery extends PaginationQuery {
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}

export class ErrorLogQuery {
  /** open (par défaut) : à traiter ; resolved : closes ; all : toutes */
  @IsOptional()
  @IsIn(['open', 'resolved', 'all'])
  status?: 'open' | 'resolved' | 'all';

  @IsOptional()
  @IsIn(['api', 'web', 'mobile'])
  source?: 'api' | 'web' | 'mobile';
}

export class ResolveErrorDto {
  /** false : rouvrir l'erreur */
  @IsOptional()
  @IsBoolean()
  resolved?: boolean;
}
