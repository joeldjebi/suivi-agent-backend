import { Injectable } from '@nestjs/common';
import {
  Role,
  SupportStatus,
  type SupportMessageInfo,
  type SupportTicketInfo,
} from '@suivi/shared';
import { In } from 'typeorm';
import type { AuthUser } from '../common/auth-user';
import { conflict, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { SupportMessage, SupportTicket, User } from '../entities';
import type { PlatformUser } from '../platform/platform-auth';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type {
  CreateTicketDto,
  PlatformTicketsQuery,
  SupportMessageDto,
} from './support.dto';

/** Contexte accepté avec une demande : quelques champs courts, rien d'autre. */
function cleanContext(context: Record<string, unknown> = {}) {
  const out: Record<string, string> = {};
  for (const key of ['page', 'userAgent', 'appVersion', 'platform'])
    if (typeof context[key] === 'string') out[key] = context[key].slice(0, 300);
  return out;
}

/**
 * Support : la structure écrit à l'éditeur, l'éditeur répond. Un fil de messages par
 * demande ; l'auteur de la demande est prévenu à chaque réponse.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  // ------------------------------------------------------------ structure

  /** L'administrateur voit toutes les demandes de la structure ; le chef, les siennes. */
  async list(user: AuthUser): Promise<SupportTicketInfo[]> {
    const tickets = await this.db.manager.find(SupportTicket, {
      where: user.role === Role.Admin ? {} : { createdById: user.id },
      order: { lastMessageAt: 'DESC' },
      take: 200,
    });
    return this.toInfo(tickets);
  }

  async get(user: AuthUser, id: string): Promise<SupportTicketInfo> {
    const ticket = await this.visible(user, id);
    return this.withMessages(ticket);
  }

  async create(user: AuthUser, dto: CreateTicketDto) {
    const m = this.db.manager;
    const author = await m.findOneByOrFail(User, { id: user.id });
    const summary = await this.subscriptions.summary(this.db.tenantId);
    const [{ id }] = await m.query<{ id: string }[]>(
      `INSERT INTO support_tickets (tenant_id, created_by_id, subject, category, status, context)
       VALUES ($1, $2, $3, $4, 'open', $5) RETURNING id`,
      [
        this.db.tenantId,
        user.id,
        dto.subject.trim(),
        dto.category,
        JSON.stringify({
          ...cleanContext(dto.context),
          role: user.role,
          plan: summary.planCode,
        }),
      ],
    );
    await this.addMessage(id, {
      authorKind: 'tenant',
      authorUserId: user.id,
      authorName: `${author.firstName} ${author.lastName}`,
      body: dto.message.trim(),
    });
    return this.get(user, id);
  }

  /** Relance ou précision : la demande repasse « en attente » de l'éditeur. */
  async reply(user: AuthUser, id: string, dto: SupportMessageDto) {
    const ticket = await this.visible(user, id);
    if (ticket.status === SupportStatus.Closed)
      throw conflict(
        'TICKET_CLOSED',
        'Cette demande est close : ouvrez-en une nouvelle',
      );
    const author = await this.db.manager.findOneByOrFail(User, {
      id: user.id,
    });
    await this.addMessage(id, {
      authorKind: 'tenant',
      authorUserId: user.id,
      authorName: `${author.firstName} ${author.lastName}`,
      body: dto.body.trim(),
    });
    await this.db.manager.update(
      SupportTicket,
      { id },
      { status: SupportStatus.Open },
    );
    return this.get(user, id);
  }

  async close(user: AuthUser, id: string) {
    await this.visible(user, id);
    await this.db.manager.update(
      SupportTicket,
      { id },
      { status: SupportStatus.Closed, closedAt: new Date() },
    );
    return this.get(user, id);
  }

  private async visible(user: AuthUser, id: string) {
    const ticket = await this.db.manager.findOneBy(SupportTicket, { id });
    if (!ticket || (user.role !== Role.Admin && ticket.createdById !== user.id))
      throw notFound('Demande');
    return ticket;
  }

  // ------------------------------------------------------------ éditeur

  /** Toutes les structures (contexte système) : en attente d'abord. */
  async platformList(query: PlatformTicketsQuery) {
    const status = query.status ?? 'all';
    const rows = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT t.id, t.number, t.subject, t.category, t.status, t.created_at AS "createdAt",
              t.last_message_at AS "lastMessageAt", t.last_author AS "lastAuthor",
              t.tenant_id AS "tenantId", te.name AS "tenantName",
              u.first_name AS "firstName", u.last_name AS "lastName", u.role,
              (SELECT count(*)::int FROM support_messages m WHERE m.ticket_id = t.id) AS messages
       FROM support_tickets t
       JOIN tenants te ON te.id = t.tenant_id
       LEFT JOIN users u ON u.id = t.created_by_id
       WHERE ($1 = 'all' OR t.status = $1) AND ($2::uuid IS NULL OR t.tenant_id = $2)
       ORDER BY (t.status = 'open') DESC, t.last_message_at DESC
       LIMIT 300`,
      [status, query.tenantId ?? null],
    );
    const [{ open }] = await this.db.manager.query<{ open: number }[]>(
      `SELECT count(*)::int AS open FROM support_tickets WHERE status = 'open'`,
    );
    return { open, items: rows };
  }

  async platformGet(id: string) {
    const ticket = await this.db.manager.findOneBy(SupportTicket, { id });
    if (!ticket) throw notFound('Demande');
    const [tenant] = await this.db.manager.query<
      { id: string; name: string }[]
    >(`SELECT id, name FROM tenants WHERE id = $1`, [ticket.tenantId]);
    return {
      ...(await this.withMessages(ticket)),
      tenant,
      context: ticket.context,
    };
  }

  /** Réponse de l'éditeur : l'auteur de la demande est prévenu. */
  async platformReply(
    admin: PlatformUser,
    id: string,
    dto: SupportMessageDto,
    ip?: string,
  ) {
    const m = this.db.manager;
    const ticket = await m.findOneBy(SupportTicket, { id });
    if (!ticket) throw notFound('Demande');
    const [me] = await m.query<{ firstName: string; lastName: string }[]>(
      `SELECT first_name AS "firstName", last_name AS "lastName" FROM platform_admins WHERE id = $1`,
      [admin.id],
    );
    await this.addMessage(
      id,
      {
        authorKind: 'platform',
        platformAdminId: admin.id,
        // Le nom de la personne n'est pas montré à la structure : « Support Suivi Agent ».
        authorName: me ? `${me.firstName} · Support` : 'Support',
        body: dto.body.trim(),
      },
      ticket.tenantId,
    );
    await m.update(
      SupportTicket,
      { id },
      { status: SupportStatus.Answered, closedAt: null },
    );
    await this.audit(
      admin,
      'support.reply',
      ticket.tenantId,
      { ticket: ticket.number },
      ip,
    );
    if (ticket.createdById) {
      const userId = ticket.createdById;
      this.db.afterCommit(() => {
        void this.db.runAsTenant(ticket.tenantId, () =>
          this.notifications.notify([userId], {
            type: 'support.reply',
            title: `Réponse du support · demande #${ticket.number}`,
            body: dto.body.trim().slice(0, 140),
            data: { ticketId: ticket.id },
          }),
        );
      });
    }
    return this.platformGet(id);
  }

  async platformSetStatus(
    admin: PlatformUser,
    id: string,
    status: SupportStatus,
    ip?: string,
  ) {
    const ticket = await this.db.manager.findOneBy(SupportTicket, { id });
    if (!ticket) throw notFound('Demande');
    await this.db.manager.update(
      SupportTicket,
      { id },
      {
        status,
        closedAt: status === SupportStatus.Closed ? new Date() : null,
      },
    );
    await this.audit(
      admin,
      'support.status',
      ticket.tenantId,
      { ticket: ticket.number, status },
      ip,
    );
    return this.platformGet(id);
  }

  // ------------------------------------------------------------ commun

  private async addMessage(
    ticketId: string,
    message: Pick<SupportMessage, 'authorKind' | 'authorName' | 'body'> &
      Partial<Pick<SupportMessage, 'authorUserId' | 'platformAdminId'>>,
    tenantId = this.db.tenantId,
  ) {
    const m = this.db.manager;
    await m.save(SupportMessage, {
      tenantId,
      ticketId,
      authorUserId: message.authorUserId ?? null,
      platformAdminId: message.platformAdminId ?? null,
      authorKind: message.authorKind,
      authorName: message.authorName,
      body: message.body,
    });
    await m.update(
      SupportTicket,
      { id: ticketId },
      { lastAuthor: message.authorKind, lastMessageAt: new Date() },
    );
  }

  private async withMessages(ticket: SupportTicket) {
    const [info] = await this.toInfo([ticket]);
    const messages = await this.db.manager.find(SupportMessage, {
      where: { ticketId: ticket.id },
      order: { createdAt: 'ASC' },
    });
    return {
      ...info,
      messages: messages.map((m): SupportMessageInfo => ({
        id: m.id,
        authorKind: m.authorKind,
        authorName: m.authorName,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  private async toInfo(tickets: SupportTicket[]): Promise<SupportTicketInfo[]> {
    const ids = [
      ...new Set(
        tickets.map((t) => t.createdById).filter((x): x is string => !!x),
      ),
    ];
    const users = ids.length
      ? await this.db.manager.find(User, {
          where: { id: In(ids) },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return tickets.map((t) => {
      const u = t.createdById ? byId.get(t.createdById) : undefined;
      return {
        id: t.id,
        number: t.number,
        subject: t.subject,
        category: t.category,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
        lastMessageAt: t.lastMessageAt.toISOString(),
        lastAuthor: t.lastAuthor,
        createdBy: u
          ? { id: u.id, firstName: u.firstName, lastName: u.lastName }
          : null,
      };
    });
  }

  private async audit(
    admin: PlatformUser,
    action: string,
    tenantId: string,
    details: Record<string, unknown>,
    ip?: string,
  ) {
    await this.db.manager.query(
      `INSERT INTO platform_audit (admin_id, action, tenant_id, details, ip) VALUES ($1, $2, $3, $4, $5)`,
      [admin.id, action, tenantId, JSON.stringify(details), ip ?? null],
    );
  }
}
