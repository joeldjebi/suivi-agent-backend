import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/** Période d'analyse : du `from` au `to` inclus (dates de la structure). 30 derniers jours par défaut. */
export class PeriodQuery {
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}

export const TIMELINE_TYPES = [
  'login',
  'zone.approved',
  'zone.rejected',
  'zone.reassigned',
  'zone.unanswered',
  'submission.rejected',
  'mission.created',
  'mission.result',
] as const;
export type TimelineType = (typeof TIMELINE_TYPES)[number];

export class TimelineQuery extends PeriodQuery {
  /** Types d'actions à afficher (tous par défaut) */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? (value as string[]) : String(value).split(','),
  )
  @IsArray()
  @IsIn(TIMELINE_TYPES, { each: true })
  types?: TimelineType[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;
}

export interface LeadStats {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  avatarVersion: number | null;
  groups: { id: string; name: string }[];
  /** Agents actifs de ses groupes */
  agents: number;
  /** Demandes de zone qui attendaient sa validation, reçues sur la période */
  requestsReceived: number;
  /** Demandes qu'il a tranchées lui-même */
  requestsDecided: number;
  requestsRejected: number;
  /** Délai moyen entre la demande et sa décision (secondes) */
  avgResponseSeconds: number | null;
  /** Demandes expirées ou validées automatiquement faute de réponse */
  requestsUnanswered: number;
  /** Demandes encore en attente maintenant */
  requestsPending: number;
  reassignments: number;
  formsRejected: number;
  missionsCreated: number;
  logins: number;
  /** Jours avec au moins une connexion sur la période */
  loginDays: number;
  lastLoginAt: string | null;
  /** Dernière action (connexion ou modification), toutes périodes confondues */
  lastActivityAt: string | null;
  /** Journées travaillées par ses agents sur la période */
  teamDays: number;
  /** Agents de l'équipe ayant travaillé au moins une journée sur la période */
  teamActiveAgents: number;
}

export interface TimelineEvent {
  type: TimelineType;
  at: string;
  agent: { id: string; name: string } | null;
  zone: string | null;
  mission: { id: string; title: string } | null;
  /** Motif, cible de la mission… */
  detail: string | null;
  /** Délai de réponse à une demande (secondes) */
  responseSeconds: number | null;
}
