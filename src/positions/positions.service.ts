import { Injectable } from '@nestjs/common';
import { DayStatus, Role, SocketEvent, ZoneExitEndReason } from '@suivi/shared';

import { In, IsNull } from 'typeorm';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { RealtimeService, statusRooms } from '../common/realtime.service';
import { toInfo, ZoneExitsService } from '../common/zone-exits.service';
import { AgentAlert, DayPause, User, WorkDay } from '../entities';
import { LiveService } from './live.service';
import { BatchResultDto, LiveQuery, PositionBatchDto } from './positions.dto';

/** Tolérance sur l'horloge du téléphone. */
const CLOCK_SKEW_MS = 5 * 60_000;

export interface TrackPoint {
  lat: number;
  lng: number;
  accuracy: number;
  speed: number | null;
  batteryLevel: number | null;
  isMocked: boolean;
  outsideZone: boolean | null;
  recordedAt: Date;
}

interface InsertedRow {
  lat: number;
  lng: number;
  accuracy: number;
  battery_level: number | null;
  is_mocked: boolean;
  outside_zone: boolean | null;
  recorded_at: Date;
}

@Injectable()
export class PositionsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly live: LiveService,
    private readonly realtime: RealtimeService,
    private readonly zoneExits: ZoneExitsService,
  ) {}

  /** Lot de positions envoyé par l'app, éventuellement après une coupure réseau (RG-11, RG-12). */
  async ingest(user: AuthUser, dto: PositionBatchDto): Promise<BatchResultDto> {
    const m = this.db.manager;
    const day = await m.findOneBy(WorkDay, { id: dto.dayId, agentId: user.id });
    if (!day) throw notFound('Journée');
    const settings = await this.access.settings();
    const pauses = settings.trackDuringPause
      ? []
      : await m.findBy(DayPause, { dayId: day.id });

    const now = Date.now();
    const from = day.startedAt.getTime() - CLOCK_SKEW_MS;
    const to = (day.endedAt?.getTime() ?? now) + CLOCK_SKEW_MS;
    const inPause = (t: number) =>
      pauses.some(
        (p) => t >= p.startedAt.getTime() && t <= (p.endedAt?.getTime() ?? now),
      );

    const valid = dto.points.filter((p) => {
      const t = Date.parse(p.recordedAt);
      return t >= from && t <= to && t <= now + CLOCK_SKEW_MS && !inPause(t);
    });
    const rejected = dto.points.length - valid.length;
    if (!valid.length) return { accepted: 0, duplicates: 0, rejected };

    const inserted = await m.query<InsertedRow[]>(
      `INSERT INTO positions (tenant_id, agent_id, day_id, lat, lng, location, accuracy, speed,
                              battery_level, is_mocked, outside_zone, recorded_at)
       SELECT $1, $2, $3, p.lat, p.lng, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326), p.accuracy,
              p.speed, p."batteryLevel", coalesce(p."isMocked", false),
              CASE WHEN z.id IS NULL THEN NULL
                   ELSE NOT ST_Contains(z.area, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)) END,
              p."recordedAt"
       FROM jsonb_to_recordset($4::jsonb) AS p(lat float8, lng float8, accuracy float4, speed float4,
              "batteryLevel" float4, "isMocked" boolean, "recordedAt" timestamptz)
       LEFT JOIN zones z ON z.id = $5
       ON CONFLICT (agent_id, recorded_at) DO NOTHING
       RETURNING lat, lng, accuracy, battery_level, is_mocked, outside_zone, recorded_at`,
      [this.db.tenantId, user.id, day.id, JSON.stringify(valid), day.zoneId],
    );

    if (inserted.length && day.status !== DayStatus.Ended) {
      await this.publishLatest(user.id, day, inserted);
    }
    // Sorties de zone, y compris pour des points reçus après coup (coupure réseau).
    await this.zoneExits.track(
      day,
      inserted.map((r) => ({
        lat: r.lat,
        lng: r.lng,
        accuracy: r.accuracy,
        recordedAt: new Date(r.recorded_at),
      })),
    );
    if (day.status === DayStatus.Ended && day.endedAt)
      await this.zoneExits.closeOpen(
        day.id,
        day.endedAt,
        ZoneExitEndReason.DayEnded,
      );
    return {
      accepted: inserted.length,
      duplicates: valid.length - inserted.length,
      rejected,
    };
  }

  /** Carte en temps réel : agents en journée, avec leur dernière position et leur statut. */
  async liveMap(user: AuthUser, query: LiveQuery) {
    const m = this.db.manager;
    const settings = await this.access.settings();
    const qb = m
      .createQueryBuilder(WorkDay, 'd')
      .innerJoinAndMapOne('d.agent', User, 'a', 'a.id = d.agentId')
      .where('d.status IN (:...statuses)', {
        statuses: [DayStatus.Active, DayStatus.Paused],
      });
    const scope = await this.access.agentScope(user);
    if (scope)
      qb.andWhere('d.agentId IN (:...scope)', {
        scope: scope.length ? scope : [null],
      });
    if (query.groupId)
      qb.andWhere('a.groupId = :groupId', { groupId: query.groupId });
    if (query.zoneId)
      qb.andWhere('d.zoneId = :zoneId', { zoneId: query.zoneId });
    if (query.status)
      qb.andWhere('d.status = :status', { status: query.status });

    const days = (await qb.getMany()) as (WorkDay & { agent: User })[];
    const positions = await this.live.all(this.db.tenantId);
    const exits = await this.zoneExits.openByDay(days.map((d) => d.id));
    const alerts = days.length
      ? await this.db.manager.find(AgentAlert, {
          select: { agentId: true, type: true },
          where: {
            agentId: In(days.map((d) => d.agentId)),
            resolvedAt: IsNull(),
          },
        })
      : [];
    const lostAfter = Date.now() - settings.signalLostMinutes * 60_000;

    return days.map((day) => {
      const position = positions.get(day.agentId);
      const exit = exits.get(day.id);
      const current = position?.dayId === day.id ? position : null;
      return {
        dayId: day.id,
        agent: {
          id: day.agent.id,
          firstName: day.agent.firstName,
          lastName: day.agent.lastName,
          groupId: day.agent.groupId,
        },
        status: day.status,
        zoneId: day.zoneId,
        startedAt: day.startedAt,
        position: current,
        // Statut « signal perdu » : aucune position récente pendant une journée en cours.
        signalLost:
          day.status === DayStatus.Active &&
          (!current || Date.parse(current.recordedAt) < lostAfter) &&
          day.startedAt.getTime() < lostAfter,
        // Sortie de zone en cours (alertedAt : le chef a été prévenu).
        zoneExit: exit ? toInfo(exit) : null,
        // Alertes en cours (immobile, batterie faible…), pour la liste « À surveiller ».
        alerts: alerts
          .filter((a) => a.agentId === day.agentId)
          .map((a) => a.type),
      };
    });
  }

  /** Trajet d'une journée. */
  async track(user: AuthUser, dayId: string): Promise<TrackPoint[]> {
    const m = this.db.manager;
    const day = await m.findOneBy(WorkDay, { id: dayId });
    if (!day) throw notFound('Journée');
    if (user.role === Role.Agent) {
      if (day.agentId !== user.id) throw notFound('Journée');
    } else {
      await this.access.assertCanManageAgent(user, day.agentId);
    }
    return m.query<TrackPoint[]>(
      `SELECT lat, lng, accuracy, speed, battery_level AS "batteryLevel", is_mocked AS "isMocked",
              outside_zone AS "outsideZone", recorded_at AS "recordedAt"
       FROM positions WHERE day_id = $1 ORDER BY recorded_at`,
      [dayId],
    );
  }

  /** Purge des positions au-delà de la durée de conservation de la structure. */
  async purge(retentionDays: number): Promise<number> {
    const result = await this.db.manager.query<unknown[]>(
      `DELETE FROM positions WHERE recorded_at < now() - make_interval(days => $1) RETURNING 1`,
      [retentionDays],
    );
    return result.length;
  }

  private async publishLatest(
    agentId: string,
    day: WorkDay,
    rows: InsertedRow[],
  ) {
    const latest = rows.reduce((a, b) =>
      a.recorded_at > b.recorded_at ? a : b,
    );
    const agent = await this.db.manager.findOneByOrFail(User, { id: agentId });
    const entry = {
      agentId,
      dayId: day.id,
      zoneId: day.zoneId,
      status: day.status,
      lat: latest.lat,
      lng: latest.lng,
      accuracy: latest.accuracy,
      batteryLevel: latest.battery_level,
      isMocked: rows.some((r) => r.is_mocked),
      outsideZone: latest.outside_zone === true,
      recordedAt: new Date(latest.recorded_at).toISOString(),
      receivedAt: new Date().toISOString(),
    };
    const tenantId = this.db.tenantId;
    this.db.afterCommit(() => {
      void this.live.upsert(tenantId, entry).then((updated) => {
        if (updated)
          this.realtime.emit(
            statusRooms(tenantId, agent),
            SocketEvent.AgentPosition,
            entry,
          );
      });
    });
  }
}

export { statusRooms };
