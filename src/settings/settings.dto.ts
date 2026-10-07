import {
  ApprovalMode,
  ExpirationAction,
  ZoneAccessWithoutGroups,
} from '@suivi/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class MixedCriteriaDto {
  @IsBoolean()
  sensitiveZone: boolean;

  /** Pourcentage de remplissage à partir duquel l'approbation est manuelle (null = inactif) */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  fillThresholdPercent: number | null;

  @IsBoolean()
  zoneChange: boolean;

  @IsBoolean()
  probationAgent: boolean;
}

export class UpdateSettingsDto {
  @IsOptional()
  @IsBoolean()
  useGroups?: boolean;

  @IsOptional()
  @IsIn(Object.values(ZoneAccessWithoutGroups))
  zoneAccessWithoutGroups?: ZoneAccessWithoutGroups;

  /** RG-27 : une zone est obligatoire pour démarrer la journée */
  @IsOptional()
  @IsBoolean()
  zoneRequired?: boolean;

  @IsOptional()
  @IsIn(Object.values(ApprovalMode))
  approvalMode?: ApprovalMode;

  @IsOptional()
  @ValidateNested()
  @Type(() => MixedCriteriaDto)
  mixedCriteria?: MixedCriteriaDto;

  /** RG-18 : délai d'expiration d'une demande en attente, en minutes */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  requestExpirationMinutes?: number;

  /** RG-28 : action à l'expiration en mode manuel */
  @IsOptional()
  @IsIn(Object.values(ExpirationAction))
  expirationActionManual?: ExpirationAction;

  /** RG-28 : action à l'expiration en mode mixte */
  @IsOptional()
  @IsIn(Object.values(ExpirationAction))
  expirationActionMixed?: ExpirationAction;

  /** RG-08 */
  @IsOptional()
  @IsBoolean()
  allowZoneChangeBeforeStart?: boolean;

  /** RG-26 : démarrage autorisé pendant l'attente d'approbation */
  @IsOptional()
  @IsBoolean()
  startWhilePending?: boolean;

  /** RG-22 : heure de remise à zéro des places, format HH:mm */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'dailyResetTime doit être au format HH:mm',
  })
  dailyResetTime?: string;

  /** Fuseau horaire IANA, par exemple Africa/Abidjan */
  @IsOptional()
  @IsString()
  timezone?: string;

  /** RG-12 */
  @IsOptional()
  @IsBoolean()
  trackDuringPause?: boolean;

  /** Fin automatique des journées ouvertes à l'heure de remise à zéro */
  @IsOptional()
  @IsBoolean()
  autoEndDayAtReset?: boolean;

  /** Délai sans position avant d'afficher « signal perdu », en minutes */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  signalLostMinutes?: number;

  /** Marge autour de la zone avant de compter une sortie, en mètres (imprécision du GPS) */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  zoneExitToleranceMeters?: number;

  /** Durée hors zone avant de prévenir le chef, en minutes */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  zoneExitAlertMinutes?: number;

  /** Heure de début attendue (HH:mm) ; null : pas d'alerte « journée pas démarrée » */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'alertStartTime doit être au format HH:mm',
  })
  alertStartTime?: string | null;

  /** Marge après l'heure de début avant l'alerte, en minutes */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  alertLateMinutes?: number;

  /** Jours travaillés : 1 = lundi … 7 = dimanche */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  alertWorkdays?: number[];

  /** Immobile depuis ce délai, en minutes ; null : pas d'alerte */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(15)
  @Max(480)
  alertImmobileMinutes?: number | null;

  /** Rayon d'immobilité, en mètres */
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(2000)
  alertImmobileRadiusM?: number;

  /** Seuil de batterie faible, en % ; null : pas d'alerte */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(5)
  @Max(50)
  alertBatteryPercent?: number | null;

  @IsOptional()
  @IsBoolean()
  alertSignalLost?: boolean;

  @IsOptional()
  @IsBoolean()
  alertMocked?: boolean;

  /** Formulaires acceptés seulement pendant une journée dans une zone de la mission */
  @IsOptional()
  @IsBoolean()
  submissionRequiresDay?: boolean;

  /** Heure du bilan de fin de journée (HH:mm) ; null : pas d'envoi */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'dailyReportTime doit être au format HH:mm',
  })
  dailyReportTime?: string | null;

  /** Durée de conservation des positions, en jours */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  positionRetentionDays?: number;
}
