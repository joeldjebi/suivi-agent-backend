// Valeurs métier issues du cahier des charges (sections 2, 5 et 6).

export const Role = {
  Admin: 'admin',
  TeamLead: 'team_lead',
  Agent: 'agent',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const DayStatus = {
  Active: 'active',
  Paused: 'paused',
  Ended: 'ended',
} as const;
export type DayStatus = (typeof DayStatus)[keyof typeof DayStatus];

export const ApprovalMode = {
  Automatic: 'automatic',
  Manual: 'manual',
  Mixed: 'mixed',
} as const;
export type ApprovalMode = (typeof ApprovalMode)[keyof typeof ApprovalMode];

export const ExpirationAction = {
  AutoApprove: 'auto_approve',
  ReleaseSeat: 'release_seat',
} as const;
export type ExpirationAction = (typeof ExpirationAction)[keyof typeof ExpirationAction];

export const ZoneRequestStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
  Expired: 'expired',
  Cancelled: 'cancelled',
  /** Place rendue : fin de journée, remise à zéro, changement de zone. */
  Released: 'released',
} as const;
export type ZoneRequestStatus = (typeof ZoneRequestStatus)[keyof typeof ZoneRequestStatus];

export const MissionStatus = {
  Todo: 'todo',
  InProgress: 'in_progress',
  Achieved: 'achieved',
  Failed: 'failed',
} as const;
export type MissionStatus = (typeof MissionStatus)[keyof typeof MissionStatus];

export const ProgressMethod = {
  Count: 'count',
  FieldSum: 'field_sum',
  Manual: 'manual',
} as const;
export type ProgressMethod = (typeof ProgressMethod)[keyof typeof ProgressMethod];

export const ZoneAccessWithoutGroups = {
  All: 'all',
  Restricted: 'restricted',
} as const;
export type ZoneAccessWithoutGroups =
  (typeof ZoneAccessWithoutGroups)[keyof typeof ZoneAccessWithoutGroups];

export const DayEndReason = {
  Manual: 'manual',
  AutoReset: 'auto_reset',
} as const;
export type DayEndReason = (typeof DayEndReason)[keyof typeof DayEndReason];

export const SubmissionStatus = {
  Accepted: 'accepted',
  Rejected: 'rejected',
} as const;
export type SubmissionStatus = (typeof SubmissionStatus)[keyof typeof SubmissionStatus];

/** Types de champs disponibles pour les formulaires de mission (RG-13). */
export const FieldType = {
  Text: 'text',
  Number: 'number',
  Boolean: 'boolean',
  Date: 'date',
  Select: 'select',
  /** Photo prise sur le terrain, avec sa position et son heure */
  Photo: 'photo',
} as const;
export type FieldType = (typeof FieldType)[keyof typeof FieldType];
