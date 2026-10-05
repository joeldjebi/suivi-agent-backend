import { Injectable } from '@nestjs/common';
import {
  ApprovalMode,
  DayStatus,
  ExpirationAction,
  Role,
  SocketEvent,
  ZoneRequestStatus,
  ZoneExitEndReason,
} from '@suivi/shared';
import { In, IsNull, LessThanOrEqual } from 'typeorm';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { conflict, forbidden, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { RealtimeService, rooms } from '../common/realtime.service';
import { workDate } from '../common/time.util';
import { ZoneExitsService } from '../common/zone-exits.service';
import { TenantSettings, User, WorkDay, Zone, ZoneRequest } from '../entities';
import { ZonesService } from '../zones/zones.service';
import { ListZoneRequestsQuery, ReassignDto } from './zone-requests.dto';

interface LockedZone {
  id: string;
  name: string;
  capacity: number | null;
  sensitive: boolean;
}

const SEAT_STATUSES = [ZoneRequestStatus.Pending, ZoneRequestStatus.Approved];

@Injectable()
export class ZoneRequestsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly zones: ZonesService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly zoneExits: ZoneExitsService,
  ) {}

  async list(user: AuthUser, query: ListZoneRequestsQuery) {
    const qb = this.db.manager
      .createQueryBuilder(ZoneRequest, 'r')
      .innerJoinAndMapOne('r.agent', User, 'a', 'a.id = r.agentId')
      .innerJoinAndMapOne('r.zone', Zone, 'z', 'z.id = r.zoneId')
      .orderBy('r.createdAt', 'DESC');
    const scope = await this.access.agentScope(user);
    if (scope)
      qb.andWhere('r.agentId IN (:...scope)', {
        scope: scope.length ? scope : [null],
      });
    if (query.status)
      qb.andWhere('r.status = :status', { status: query.status });
    if (query.agentId)
      qb.andWhere('r.agentId = :agentId', { agentId: query.agentId });
    if (query.zoneId)
      qb.andWhere('r.zoneId = :zoneId', { zoneId: query.zoneId });
    const [items, total] = await qb
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return { items, total, page: query.page, limit: query.limit };
  }

  /** Choix ou changement de zone par l'agent (RG-05 à RG-09, RG-17, RG-20). */
  async request(user: AuthUser, zoneId: string): Promise<ZoneRequest> {
    const m = this.db.manager;
    const settings = await this.access.settings();
    const agent = await this.access.getAgent(user.id);

    if (settings.useGroups && !agent.groupId) {
      throw conflict(
        'NO_GROUP',
        "Vous n'êtes rattaché à aucun groupe. Contactez votre administrateur.",
      );
    }
    if (await this.openDay(agent.id)) {
      throw conflict(
        'DAY_STARTED',
        'Impossible de changer de zone une fois la journée démarrée',
      );
    }
    const accessible = await this.zones.accessibleZoneIds(agent, settings);
    if (!accessible.includes(zoneId)) {
      throw forbidden("Cette zone n'est pas accessible pour vous");
    }
    if (
      await m.existsBy(ZoneRequest, {
        agentId: agent.id,
        status: ZoneRequestStatus.Pending,
      })
    ) {
      throw conflict(
        'REQUEST_PENDING',
        'Une demande est déjà en attente d’approbation',
      );
    }

    const approved = await m.findOneBy(ZoneRequest, {
      agentId: agent.id,
      status: ZoneRequestStatus.Approved,
    });
    if (approved?.zoneId === zoneId) {
      throw conflict('ALREADY_IN_ZONE', 'Vous êtes déjà dans cette zone');
    }
    if (approved && !settings.allowZoneChangeBeforeStart) {
      throw forbidden('Votre structure n’autorise pas le changement de zone');
    }

    const zone = await this.lockZone(zoneId);
    const taken = await this.seatsTaken(zoneId);
    if (zone.capacity !== null && taken >= zone.capacity) {
      throw conflict(
        'ZONE_FULL',
        `La zone ${zone.name} est complète. Choisissez une autre zone.`,
      );
    }

    const isChange = !!approved;
    const requiresApproval = this.requiresApproval(
      settings,
      zone,
      taken,
      isChange,
      agent,
    );
    const now = new Date();
    const base = {
      tenantId: this.db.tenantId,
      agentId: agent.id,
      zoneId,
      isChange,
      requiresApproval,
      workDate: workDate(now, settings.timezone, settings.dailyResetTime),
    };

    if (!requiresApproval) {
      if (approved) await this.release(approved, 'zone_change');
      const saved = await m.save(ZoneRequest, {
        ...base,
        status: ZoneRequestStatus.Approved,
        decidedAt: now,
        decisionReason: 'auto',
      });
      this.emitDecided(saved);
      return saved;
    }

    // RG-17 : la demande en attente réserve la place ; RG-20 : l'agent garde sa zone actuelle.
    const pending = await m.save(ZoneRequest, {
      ...base,
      status: ZoneRequestStatus.Pending,
      expiresAt: new Date(
        now.getTime() + settings.requestExpirationMinutes * 60_000,
      ),
    });
    const approvers = await this.access.approverIds(agent, settings);
    await this.notifications.notify(approvers, {
      type: 'zone_request.created',
      title: 'Demande de zone à approuver',
      body: `${agent.firstName} ${agent.lastName} demande la zone ${zone.name}`,
      data: { requestId: pending.id, agentId: agent.id, zoneId },
    });
    this.db.afterCommit(() =>
      this.realtime.emit(
        approvers.map(rooms.user),
        SocketEvent.ZoneRequestCreated,
        pending,
      ),
    );
    return pending;
  }

  /** L'agent annule sa demande en attente : la place est libérée. */
  async cancel(user: AuthUser, requestId: string): Promise<ZoneRequest> {
    const request = await this.lockRequest(requestId);
    if (request.agentId !== user.id) throw forbidden();
    this.assertPending(request);
    await this.db.manager.update(
      ZoneRequest,
      { id: request.id },
      {
        status: ZoneRequestStatus.Cancelled,
        releasedAt: new Date(),
        releaseReason: 'cancelled_by_agent',
      },
    );
    return this.db.manager.findOneByOrFail(ZoneRequest, { id: request.id });
  }

  /** Approbation ou refus par le chef d'équipe ou l'administrateur (RG-07, RG-16, RG-19). */
  async decide(
    user: AuthUser,
    requestId: string,
    approve: boolean,
    reason?: string,
  ) {
    const request = await this.lockRequest(requestId);
    await this.assertCanDecide(user, request.agentId);
    this.assertPending(request);

    if (approve) return this.approve(request, user.id, reason ?? null);

    await this.db.manager.update(
      ZoneRequest,
      { id: request.id },
      {
        status: ZoneRequestStatus.Rejected,
        decidedById: user.id,
        decidedAt: new Date(),
        decisionReason: reason ?? null,
        releasedAt: new Date(),
        releaseReason: 'rejected',
      },
    );
    const rejected = await this.db.manager.findOneByOrFail(ZoneRequest, {
      id: request.id,
    });
    const zone = await this.db.manager.findOneByOrFail(Zone, {
      id: request.zoneId,
    });
    await this.notifications.notify([request.agentId], {
      type: 'zone_request.rejected',
      title: 'Demande de zone refusée',
      body: reason
        ? `Zone ${zone.name} : ${reason}`
        : `Votre demande pour la zone ${zone.name} a été refusée`,
      data: { requestId: request.id, zoneId: request.zoneId },
    });
    this.emitDecided(rejected);
    return rejected;
  }

  /** Réaffectation d'un agent par un responsable, y compris en cours de journée (RG-31, RG-32). */
  async reassign(user: AuthUser, dto: ReassignDto): Promise<ZoneRequest> {
    const m = this.db.manager;
    const agent = await this.access.assertCanManageAgent(user, dto.agentId);
    const settings = await this.access.settings();
    if (dto.force && user.role !== Role.Admin) {
      throw forbidden(
        'Seul un administrateur peut dépasser la capacité d’une zone',
      );
    }
    if (user.role !== Role.Admin) {
      const accessible = await this.zones.accessibleZoneIds(agent, settings);
      if (!accessible.includes(dto.zoneId))
        throw forbidden("Cette zone n'est pas accessible à cet agent");
    }

    const zone = await this.lockZone(dto.zoneId);
    const approved = await m.findOneBy(ZoneRequest, {
      agentId: agent.id,
      status: ZoneRequestStatus.Approved,
    });
    if (approved?.zoneId === dto.zoneId) {
      throw conflict('ALREADY_IN_ZONE', 'L’agent est déjà dans cette zone');
    }
    const taken = await this.seatsTaken(dto.zoneId);
    const full = zone.capacity !== null && taken >= zone.capacity;
    if (full && !dto.force) {
      throw conflict('ZONE_FULL', `La zone ${zone.name} est complète`);
    }

    await m.update(
      ZoneRequest,
      { agentId: agent.id, status: ZoneRequestStatus.Pending },
      {
        status: ZoneRequestStatus.Cancelled,
        releasedAt: new Date(),
        releaseReason: 'reassigned',
      },
    );
    if (approved) await this.release(approved, 'reassigned');

    const now = new Date();
    const saved = await m.save(ZoneRequest, {
      tenantId: this.db.tenantId,
      agentId: agent.id,
      zoneId: dto.zoneId,
      status: ZoneRequestStatus.Approved,
      isChange: !!approved,
      requiresApproval: false,
      workDate: workDate(now, settings.timezone, settings.dailyResetTime),
      decidedById: user.id,
      decidedAt: now,
      decisionReason: full ? 'reassigned_over_capacity' : 'reassigned',
    });
    const day = await m.findOneBy(WorkDay, {
      agentId: agent.id,
      status: In([DayStatus.Active, DayStatus.Paused]),
    });
    if (day) {
      await this.zoneExits.closeOpen(
        day.id,
        now,
        ZoneExitEndReason.ZoneChanged,
      );
      await m.update(WorkDay, { id: day.id }, { zoneId: dto.zoneId });
    }
    await this.notifications.notify([agent.id], {
      type: 'zone_request.reassigned',
      title: 'Changement de zone',
      body: `Vous avez été affecté à la zone ${zone.name}`,
      data: { requestId: saved.id, zoneId: dto.zoneId },
    });
    this.emitDecided(saved);
    return saved;
  }

  /**
   * Traitement des demandes en attente d'une structure (appelé par le planificateur) :
   * relance à mi-délai (RG-29) puis expiration (RG-18, RG-28, RG-30).
   */
  async processPending(
    settings: TenantSettings,
    now = new Date(),
  ): Promise<void> {
    const m = this.db.manager;

    const toRemind = await m
      .createQueryBuilder(ZoneRequest, 'r')
      .where('r.status = :status', { status: ZoneRequestStatus.Pending })
      .andWhere('r.reminderSentAt IS NULL')
      .andWhere('r.expiresAt > :now', { now })
      .andWhere(`r.createdAt + (r.expiresAt - r.createdAt) / 2 <= :now`, {
        now,
      })
      .getMany();
    for (const request of toRemind) {
      const agent = await this.access.getAgent(request.agentId);
      const recipients = [
        ...(await this.access.approverIds(agent, settings)),
        ...(await this.access.adminIds()),
      ];
      await this.notifications.notify(recipients, {
        type: 'zone_request.reminder',
        title: 'Demande de zone toujours en attente',
        body: `${agent.firstName} ${agent.lastName} attend une réponse`,
        data: { requestId: request.id },
      });
      await m.update(ZoneRequest, { id: request.id }, { reminderSentAt: now });
    }

    const expired = await m.find(ZoneRequest, {
      where: {
        status: ZoneRequestStatus.Pending,
        expiresAt: LessThanOrEqual(now),
      },
      lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
    });
    const action =
      settings.approvalMode === ApprovalMode.Manual
        ? settings.expirationActionManual
        : settings.approvalMode === ApprovalMode.Mixed
          ? settings.expirationActionMixed
          : ExpirationAction.AutoApprove;

    for (const request of expired) {
      if (action === ExpirationAction.AutoApprove) {
        await this.approve(request, null, 'expired_auto_approved');
        continue;
      }
      await m.update(
        ZoneRequest,
        { id: request.id },
        {
          status: ZoneRequestStatus.Expired,
          releasedAt: now,
          releaseReason: 'expired',
        },
      );
      await this.notifications.notify([request.agentId], {
        type: 'zone_request.expired',
        title: 'Demande de zone expirée',
        body: 'Votre demande n’a pas reçu de réponse à temps. Choisissez à nouveau une zone.',
        data: { requestId: request.id },
      });
      this.emitDecided(
        await m.findOneByOrFail(ZoneRequest, { id: request.id }),
      );
    }
  }

  /** Libère la place occupée par l'agent (RG-21). */
  async releaseApproved(agentId: string, reason: string): Promise<void> {
    await this.db.manager.update(
      ZoneRequest,
      { agentId, status: ZoneRequestStatus.Approved },
      {
        status: ZoneRequestStatus.Released,
        releasedAt: new Date(),
        releaseReason: reason,
      },
    );
  }

  /** Mode mixte : approbation manuelle si au moins un critère activé est rempli (RG-23, RG-24). */
  private requiresApproval(
    settings: TenantSettings,
    zone: LockedZone,
    taken: number,
    isChange: boolean,
    agent: User,
  ): boolean {
    if (settings.approvalMode === ApprovalMode.Automatic) return false;
    if (settings.approvalMode === ApprovalMode.Manual) return true;
    const c = settings.mixedCriteria;
    const fillPercent = zone.capacity ? ((taken + 1) / zone.capacity) * 100 : 0;
    return (
      (c.sensitiveZone && zone.sensitive) ||
      (c.fillThresholdPercent !== null &&
        zone.capacity !== null &&
        fillPercent >= c.fillThresholdPercent) ||
      (c.zoneChange && isChange) ||
      (c.probationAgent && agent.onProbation)
    );
  }

  private async approve(
    request: ZoneRequest,
    deciderId: string | null,
    reason: string | null,
  ) {
    const m = this.db.manager;
    const previous = await m.findOneBy(ZoneRequest, {
      agentId: request.agentId,
      status: ZoneRequestStatus.Approved,
    });
    if (previous) await this.release(previous, 'zone_change');
    await m.update(
      ZoneRequest,
      { id: request.id },
      {
        status: ZoneRequestStatus.Approved,
        decidedById: deciderId,
        decidedAt: new Date(),
        decisionReason: reason,
      },
    );
    // Démarrage pendant l'attente (RG-26) : la journée reçoit sa zone à l'approbation.
    await m.update(
      WorkDay,
      {
        agentId: request.agentId,
        status: In([DayStatus.Active, DayStatus.Paused]),
        zoneId: IsNull(),
      },
      { zoneId: request.zoneId },
    );
    const approved = await m.findOneByOrFail(ZoneRequest, { id: request.id });
    const zone = await m.findOneByOrFail(Zone, { id: request.zoneId });
    await this.notifications.notify([request.agentId], {
      type: 'zone_request.approved',
      title: 'Demande de zone approuvée',
      body: `Vous pouvez travailler dans la zone ${zone.name}`,
      data: { requestId: request.id, zoneId: request.zoneId },
    });
    this.emitDecided(approved);
    return approved;
  }

  private async release(request: ZoneRequest, reason: string) {
    await this.db.manager.update(
      ZoneRequest,
      { id: request.id },
      {
        status: ZoneRequestStatus.Released,
        releasedAt: new Date(),
        releaseReason: reason,
      },
    );
  }

  /** Verrou sur la zone : deux agents ne peuvent pas prendre la dernière place en même temps. */
  private async lockZone(zoneId: string): Promise<LockedZone> {
    const [zone] = await this.db.manager.query<LockedZone[]>(
      `SELECT id, name, capacity, sensitive FROM zones WHERE id = $1 AND is_active FOR UPDATE`,
      [zoneId],
    );
    if (!zone) throw notFound('Zone');
    return zone;
  }

  private seatsTaken(zoneId: string): Promise<number> {
    return this.db.manager.countBy(ZoneRequest, {
      zoneId,
      status: In(SEAT_STATUSES),
    });
  }

  private async lockRequest(requestId: string): Promise<ZoneRequest> {
    const request = await this.db.manager.findOne(ZoneRequest, {
      where: { id: requestId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!request) throw notFound('Demande');
    return request;
  }

  private assertPending(request: ZoneRequest) {
    if (request.status !== ZoneRequestStatus.Pending) {
      throw conflict('REQUEST_NOT_PENDING', 'Cette demande a déjà été traitée');
    }
  }

  private async assertCanDecide(user: AuthUser, agentId: string) {
    if (user.role === Role.Agent) throw forbidden();
    await this.access.assertCanManageAgent(user, agentId);
  }

  private openDay(agentId: string) {
    return this.db.manager.existsBy(WorkDay, {
      agentId,
      status: In([DayStatus.Active, DayStatus.Paused]),
    });
  }

  private emitDecided(request: ZoneRequest) {
    this.db.afterCommit(() =>
      this.realtime.emit(
        [rooms.user(request.agentId)],
        SocketEvent.ZoneRequestDecided,
        request,
      ),
    );
  }
}
