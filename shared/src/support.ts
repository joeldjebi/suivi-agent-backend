/** Support : demandes d'aide des structures, traitées par l'éditeur de la plateforme. */
export const SupportCategory = {
  Question: 'question',
  Bug: 'bug',
  Billing: 'billing',
  Feature: 'feature',
  Account: 'account',
  Other: 'other',
} as const;
export type SupportCategory = (typeof SupportCategory)[keyof typeof SupportCategory];

export const SupportStatus = {
  /** En attente d'une réponse de l'éditeur */
  Open: 'open',
  /** L'éditeur a répondu ; la structure peut relancer */
  Answered: 'answered',
  Closed: 'closed',
} as const;
export type SupportStatus = (typeof SupportStatus)[keyof typeof SupportStatus];

export interface SupportMessageInfo {
  id: string;
  /** tenant : la structure ; platform : l'éditeur */
  authorKind: 'tenant' | 'platform';
  authorName: string;
  body: string;
  createdAt: string;
}

export interface SupportTicketInfo {
  id: string;
  number: number;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  createdAt: string;
  lastMessageAt: string;
  lastAuthor: 'tenant' | 'platform';
  createdBy: { id: string; firstName: string; lastName: string } | null;
  messages?: SupportMessageInfo[];
}

/** Article du manuel d'utilisation (Markdown). */
export type DocAudience = 'admin' | 'team_lead' | 'agent';

export interface DocArticleSummary {
  slug: string;
  section: string;
  title: string;
  summary: string;
  position: number;
  updatedAt: string;
}

export interface DocArticle extends DocArticleSummary {
  body: string;
}
