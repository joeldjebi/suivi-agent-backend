import { Injectable } from '@nestjs/common';
import {
  AlertType,
  DayEndReason,
  DayStatus,
  Role,
  SocketEvent,
  ZoneExitEndReason,
  ZoneRequestStatus,
} from '@suivi/shared';
import { In, IsNull } from 'typeorm';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { conflict, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { RealtimeService } from '../common/realtime.service';
import { AlertsService } from '../common/alerts.service';
import { workDate } from '../common/time.util';
import { toInfo, ZoneExitsService } from '../common/zone-exits.service';
import { DayPause, User, WorkDay, ZoneRequest } from '../entities';
import { LiveService } from '../positions/live.service';
import { statusRooms } from '../positions/positions.service';
import { ZoneRequestsService } from '../zone-requests/zone-requests.service';
import { DayHistoryQuery } from './days.dto';

const OPEN = [DayStatus.Active, DayStatus.Paused];

@Injectable()
export class DaysService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly zoneRequests: ZoneRequestsService,
    private readonly live: LiveService,
    private readonly realtime: RealtimeService,
    private readonly zoneExits: ZoneExitsService,
    private readonly alerts: AlertsService,
  ) {}

  /** État courant de l'agent : journée ouverte, zone approuvée et demande en attente. */
  async current(agentId: string) {
    const m = this.db.manager;
    const day = await m.findOne(WorkDay, {
      where: { agentId, status: In(OPEN) },
      relations: { pauses: true },
    });
    const seats = await m.find(ZoneRequest, {
      where: {
        agentId,
        status: In([ZoneRequestStatus.Pending, ZoneRequestStatus.Approved]),
      },
    });
    return {
      day: day ? withDurations(day) : null,
      approved:
        seats.find((s) => s.status === ZoneRequestStatus.Approved) ?? null,
      pending:
        seats.find((s) => s.status === ZoneRequestStatus.Pending) ?? null,
    };
  }

  /** Démarrer la journée (RG-10, RG-25 à RG-27). */
  async start(user: AuthUser) {
    const m = this.db.manager;
    const settings = await this.access.settings();
    const agent = await this.access.getAgent(user.id);
    const { day, approved, pending } = await this.current(agent.id);
    if (day)
      throw conflict('DAY_ALREADY_STARTED', 'Votre journée est déjà démarrée');

    let zoneId: string | null = null;
    if (approved) {
      zoneId = approved.zoneId;
    } else if (pending && !settings.startWhilePending) {
      throw conflict(
        'PENDING_APPROVAL',
        'Votre choix de zone est en attente d’approbation',
      );
    } else if (!pending && settings.zoneRequired) {
      throw conflict(
        'ZONE_REQUIRED',
        'Choisissez une zone avant de démarrer votre journée',
      );
    }

    const now = new Date();
    const saved = await m.save(WorkDay, {
      tenantId: this.db.tenantId,
      agentId: agent.id,
      zoneId,
      status: DayStatus.Active,
      workDate: workDate(now, settings.timezone, settings.dailyResetTime),
      startedAt: now,
    });
    await this.alerts.resolve(agent.id, AlertType.LateStart, now);
    this.emitStatus(agent, saved);
    return this.get(saved.id);
  }

  async pause(user: AuthUser) {
    const day = await this.openDayOrFail(user.id);
    if (day.status !== DayStatus.Active) {
      throw conflict('DAY_NOT_ACTIVE', 'La journée est déjà en pause');
    }
    const m = this.db.manager;
    await m.update(WorkDay, { id: day.id }, { status: DayStatus.Paused });
    await m.insert(DayPause, {
      tenantId: this.db.tenantId,
      dayId: day.id,
      startedAt: new Date(),
    });
    return this.afterChange(user.id, day.id);
  }

  async resume(user: AuthUser) {
    const day = await this.openDayOrFail(user.id);
    if (day.status !== DayStatus.Paused) {
      throw conflict('DAY_NOT_PAUSED', "La journée n'est pas en pause");
    }
    const m = this.db.manager;
    await m.update(WorkDay, { id: day.id }, { status: DayStatus.Active });
    await m.update(
      DayPause,
      { dayId: day.id, endedAt: IsNull() },
      { endedAt: new Date() },
    );
    return this.afterChange(user.id, day.id);
  }

  async end(user: AuthUser) {
    const day = await this.openDayOrFail(user.id);
    await this.endDay(day, DayEndReason.Manual);
    return this.get(day.id);
  }

  /** Termine une journée : la place de l'agent est libérée (RG-21) et le suivi s'arrête. */
  async endDay(day: WorkDay, reason: DayEndReason) {
    const m = this.db.manager;
    const now = new Date();
    await m.update(
      DayPause,
      { dayId: day.id, endedAt: IsNull() },
      { endedAt: now },
    );
    await m.update(
      WorkDay,
      { id: day.id },
      { status: DayStatus.Ended, endedAt: now, endReason: reason },
    );
    await this.zoneExits.closeOpen(day.id, now, ZoneExitEndReason.DayEnded);
    await this.alerts.resolveDay(day.id, now);
    await this.zoneRequests.releaseApproved(day.agentId, 'day_ended');
    await m.update(
      ZoneRequest,
      { agentId: day.agentId, status: ZoneRequestStatus.Pending },
      {
        status: ZoneRequestStatus.Cancelled,
        releasedAt: now,
        releaseReason: 'day_ended',
      },
    );
    const agent = await m.findOneByOrFail(User, { id: day.agentId });
    const tenantId = this.db.tenantId;
    this.db.afterCommit(() => void this.live.remove(tenantId, day.agentId));
    this.emitStatus(agent, {
      ...day,
      status: DayStatus.Ended,
      endedAt: now,
      endReason: reason,
    });
  }

  /** Sorties de zone d'une journée (l'agent pour lui-même, ses responsables). */
  async zoneExitsOf(user: AuthUser, dayId: string) {
    await this.getForUser(user, dayId);
    return (await this.zoneExits.list(dayId)).map(toInfo);
  }

  /** Historique des journées : heure de début, pauses et heure de fin. */
  async history(user: AuthUser, query: DayHistoryQuery) {
    const qb = this.db.manager
      .createQueryBuilder(WorkDay, 'd')
      .innerJoinAndMapOne('d.agent', User, 'a', 'a.id = d.agentId')
      .leftJoinAndSelect('d.pauses', 'p')
      .orderBy('d.startedAt', 'DESC')
      .addOrderBy('p.startedAt', 'ASC');
    const scope = await this.access.agentScope(user);
    if (scope)
      qb.andWhere('d.agentId IN (:...scope)', {
        scope: scope.length ? scope : [null],
      });
    if (query.agentId)
      qb.andWhere('d.agentId = :agentId', { agentId: query.agentId });
    if (query.groupId)
      qb.andWhere('a.groupId = :groupId', { groupId: query.groupId });
    if (query.from) qb.andWhere('d.workDate >= :from', { from: query.from });
    if (query.to) qb.andWhere('d.workDate <= :to', { to: query.to });
    if (query.status)
      qb.andWhere('d.status = :status', { status: query.status });
    const [items, total] = await qb
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    const workdays = await this.access.workdays([
      ...new Set(items.map((d) => d.agentId)),
    ]);
    return {
      items: items.map((d) => ({
        ...withDurations(d),
        targetMinutes: workdays.get(d.agentId)?.minutes ?? null,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async getForUser(user: AuthUser, id: string) {
    const day = await this.get(id);
    if (user.role === Role.Agent && day.agentId !== user.id)
      throw notFound('Journée');
    if (user.role === Role.TeamLead)
      await this.access.assertCanManageAgent(user, day.agentId);
    return day;
  }

  /** Journées encore ouvertes (pour la remise à zéro quotidienne). */
  openDays(): Promise<WorkDay[]> {
    return this.db.manager.findBy(WorkDay, { status: In(OPEN) });
  }

  private async get(id: string) {
    const day = await this.db.manager.findOne(WorkDay, {
      where: { id },
      relations: { pauses: true },
    });
    if (!day) throw notFound('Journée');
    day.pauses?.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    return withDurations(day);
  }

  private async openDayOrFail(agentId: string): Promise<WorkDay> {
    const day = await this.db.manager.findOne(WorkDay, {
      where: { agentId, status: In(OPEN) },
      lock: { mode: 'pessimistic_write' },
    });
    if (!day)
      throw conflict('NO_OPEN_DAY', "Vous n'avez pas de journée en cours");
    return day;
  }

  private async afterChange(agentId: string, dayId: string) {
    const day = await this.get(dayId);
    const agent = await this.db.manager.findOneByOrFail(User, { id: agentId });
    const tenantId = this.db.tenantId;
    this.db.afterCommit(
      () => void this.live.setStatus(tenantId, agentId, day.status),
    );
    this.emitStatus(agent, day);
    return day;
  }

  private emitStatus(
    agent: User,
    day: Pick<WorkDay, 'id' | 'status' | 'zoneId'> & Partial<WorkDay>,
  ) {
    const tenantId = this.db.tenantId;
    const payload = {
      agentId: agent.id,
      dayId: day.id,
      status: day.status,
      zoneId: day.zoneId,
      startedAt: day.startedAt,
      endedAt: day.endedAt ?? null,
    };
    this.db.afterCommit(() =>
      this.realtime.emit(
        statusRooms(tenantId, agent),
        SocketEvent.AgentStatus,
        payload,
      ),
    );
  }
}

/** Ajoute les durées travaillées et en pause, en secondes. */
function withDurations(day: WorkDay) {
  const end = (day.endedAt ?? new Date()).getTime();
  const pausedMs = (day.pauses ?? []).reduce(
    (total, p) =>
      total + ((p.endedAt ?? new Date()).getTime() - p.startedAt.getTime()),
    0,
  );
  const totalMs = end - day.startedAt.getTime();
  return {
    ...day,
    pausedSeconds: Math.round(pausedMs / 1000),
    workedSeconds: Math.round((totalMs - pausedMs) / 1000),
  };
}
