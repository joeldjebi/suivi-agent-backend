import type { DayStatus } from './enums';

/** Un point GPS envoyé par l'app mobile (envoi par lots, section 8). */
export interface PositionPoint {
  lat: number;
  lng: number;
  accuracy: number;
  speed?: number;
  batteryLevel?: number;
  isMocked?: boolean;
  recordedAt: string; // ISO 8601, heure du téléphone
}

export interface PositionBatch {
  dayId: string;
  points: PositionPoint[];
}

export interface MissionField {
  key: string;
  label: string;
  type: import('./enums').FieldType;
  required: boolean;
  options?: string[];
}

/** Position diffusée en temps réel à la carte web. */
export interface LiveAgentPosition {
  agentId: string;
  zoneId: string | null;
  status: DayStatus;
  lat: number;
  lng: number;
  accuracy: number;
  batteryLevel: number | null;
  isMocked: boolean;
  outsideZone: boolean;
  recordedAt: string;
}

export const SocketEvent = {
  AgentPosition: 'agent:position',
  AgentStatus: 'agent:status',
  ZoneRequestCreated: 'zone-request:created',
  ZoneRequestDecided: 'zone-request:decided',
  Notification: 'notification',
  /** Sortie de zone confirmée (chef prévenu) ou retour dans la zone. */
  AgentZoneExit: 'agent:zone-exit',
  /** Alerte ouverte, refermée ou prise en charge. */
  AgentAlert: 'agent:alert',
} as const;
export type SocketEvent = (typeof SocketEvent)[keyof typeof SocketEvent];

/** Pourquoi une sortie de zone est close. */
export const ZoneExitEndReason = {
  Returned: 'returned',
  DayEnded: 'day_ended',
  ZoneChanged: 'zone_changed',
} as const;
export type ZoneExitEndReason =
  (typeof ZoneExitEndReason)[keyof typeof ZoneExitEndReason];

/** Passage d'un agent hors de sa zone pendant sa journée. */
export interface ZoneExitInfo {
  id: string;
  dayId: string;
  agentId: string;
  zoneId: string;
  exitedAt: string;
  /** Vide : l'agent est toujours hors de sa zone */
  endedAt: string | null;
  endReason: ZoneExitEndReason | null;
  /** Plus grande distance à la zone, en mètres */
  maxDistanceM: number;
  /** Le chef a été prévenu (sortie plus longue que le délai d'alerte) */
  alertedAt: string | null;
}

/** Alertes intelligentes des responsables. */
export const AlertType = {
  /** Aucune position depuis le délai « signal perdu » */
  SignalLost: 'signal_lost',
  /** Pas de déplacement notable depuis un moment */
  Immobile: 'immobile',
  LowBattery: 'low_battery',
  /** Application de fausse position détectée */
  Mocked: 'mocked',
  /** Hors de sa zone au-delà du délai d'alerte */
  OutOfZone: 'out_of_zone',
  /** Journée pas démarrée après l'heure attendue */
  LateStart: 'late_start',
} as const;
export type AlertType = (typeof AlertType)[keyof typeof AlertType];

export interface AgentAlertInfo {
  id: string;
  type: AlertType;
  agent: { id: string; firstName: string; lastName: string; groupId: string | null };
  dayId: string | null;
  startedAt: string;
  /** Vide : la situation dure encore */
  resolvedAt: string | null;
  /** Détails selon le type (dernière position, niveau de batterie, distance…) */
  data: Record<string, unknown>;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string; firstName: string; lastName: string } | null;
  note: string | null;
}

/** Bilan de fin de journée d'une équipe (ou de la structure). */
export interface DailyReportAgent {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  group: string | null;
  /** not_started : pas de journée ; working : en cours ou en pause ; ended ; auto : fin automatique */
  status: 'not_started' | 'working' | 'ended' | 'auto';
  zone: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Temps travaillé, pauses déduites, en minutes */
  workedMinutes: number;
  /** Durée de travail attendue (agent, groupe ou structure), en minutes */
  targetMinutes: number | null;
  pausesMinutes: number;
  formsAccepted: number;
  formsRejected: number;
  zoneExits: number;
  outsideMinutes: number;
  /** Types d'alertes ouvertes ce jour-là */
  alerts: string[];
  /** Démarré après l'heure attendue (si la structure l'a réglée) */
  late: boolean;
}

export interface DailyReport {
  date: string;
  summary: {
    agents: number;
    worked: number;
    notStarted: number;
    late: number;
    workedMinutes: number;
    formsAccepted: number;
    formsRejected: number;
    zoneExits: number;
    alerts: number;
    autoClosed: number;
  };
  agents: DailyReportAgent[];
}
