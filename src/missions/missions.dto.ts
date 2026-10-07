import { PartialType, PickType } from '@nestjs/swagger';
import {
  FieldType,
  MissionStatus,
  ProgressMethod,
  SubmissionStatus,
} from '@suivi/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../common/pagination.dto';

export class MissionFieldDto {
  /** Identifiant technique du champ (minuscules, chiffres, _) */
  @Matches(/^[a-z][a-z0-9_]{0,49}$/)
  key: string;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsIn(Object.values(FieldType))
  type: FieldType;

  @IsBoolean()
  required: boolean;

  /** Valeurs possibles pour un champ « select » */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  options?: string[];
}

export class CreateMissionTypeDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MissionFieldDto)
  fields: MissionFieldDto[];
}

export class UpdateMissionTypeDto extends PartialType(CreateMissionTypeDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ObjectiveTierDto {
  /** Taux d'atteinte minimum, en % */
  @IsInt()
  @Min(1)
  @Max(1000)
  thresholdPercent: number;

  @IsInt()
  @Min(1)
  @Max(10_000_000)
  amount: number;
}

/**
 * Rémunération propre à la mission (administrateur, formule Entreprise). Remplace la grille
 * de l'agent pour les formulaires et l'objectif de la mission ; un élément vide ne rapporte rien.
 */
export class MissionPayDto {
  /** Par formulaire accepté */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  perForm?: number | null;

  /** Commission sur les montants saisis (mission « somme d'un champ »), en % */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  commissionPercent?: number | null;

  /** Primes d'objectif (le palier atteint le plus haut est retenu) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ObjectiveTierDto)
  objectiveBonus?: ObjectiveTierDto[] | null;

  /** Chef d'équipe : par formulaire accepté de son équipe sur la mission */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  leadPerTeamForm?: number | null;
}

export class CreateMissionDto {
  @IsUUID()
  typeId: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Zones où la mission se fait (au moins une) : l'agent la voit en choisissant l'une d'elles */
  @IsArray()
  @ArrayMinSize(1, { message: 'Choisissez au moins une zone' })
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  zoneIds: string[];

  /** Agent assigné (exclusif avec assigneeGroupId) ; ni agent ni groupe : ouverte à tous les agents de ses zones */
  @IsOptional()
  @IsUUID()
  assigneeAgentId?: string;

  /** Groupe assigné : objectif collectif (RG-38) */
  @IsOptional()
  @IsUUID()
  assigneeGroupId?: string;

  /** RG-36 : count = nombre de formulaires, field_sum = somme d'un champ, manual = validation par le chef */
  @IsIn(Object.values(ProgressMethod))
  progressMethod: ProgressMethod;

  /** Valeur cible (ignorée en validation manuelle) */
  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  targetValue?: number;

  /** Champ numérique additionné pour la méthode field_sum */
  @IsOptional()
  @IsString()
  sumFieldKey?: string;

  /** Échéance (ISO 8601) */
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  /** Rémunération propre (administrateur) ; absente : grille de l'agent */
  @IsOptional()
  @ValidateNested()
  @Type(() => MissionPayDto)
  pay?: MissionPayDto;
}

export class UpdateMissionDto extends PartialType(
  PickType(CreateMissionDto, [
    'title',
    'description',
    'targetValue',
    'dueDate',
  ] as const),
) {
  /** Nouvelles zones de la mission (remplacent les précédentes) */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Choisissez au moins une zone' })
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  zoneIds?: string[];

  /** false = désactiver (plus proposée aux agents) ; true = réactiver */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ManualResultDto {
  /** true = objectif atteint, false = échoué */
  @IsBoolean()
  achieved: boolean;
}

export class ListMissionsQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(Object.values(MissionStatus))
  status?: MissionStatus;

  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;

  /** Recherche dans le titre */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsUUID()
  typeId?: string;

  /** Missions qui se font dans cette zone */
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  /** Plus récentes (défaut), échéance la plus proche, ou titre */
  @IsOptional()
  @IsIn(['recent', 'due', 'title'])
  sort?: 'recent' | 'due' | 'title';

  /** Inclure les missions désactivées (administrateur et chef d'équipe) */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

/** Filtres des formulaires d'une mission (chef d'équipe, administrateur). */
export class ListSubmissionsQuery {
  /** Formulaires d'un seul agent */
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @IsIn(Object.values(SubmissionStatus))
  status?: SubmissionStatus;

  /** Saisis à partir de cet instant (ISO 8601) */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Saisis avant cet instant (ISO 8601, exclu) */
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class CreateSubmissionDto {
  /** UUID généré par le téléphone : un renvoi après coupure ne crée pas de doublon */
  @IsUUID()
  clientId: string;

  /** Valeurs des champs du type de mission, par clé */
  @IsObject()
  data: Record<string, unknown>;

  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  /** Heure de saisie sur le téléphone (ISO 8601) */
  @IsDateString()
  submittedAt: string;
}

export class RejectSubmissionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
