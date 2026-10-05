import { Injectable } from '@nestjs/common';
import {
  AlertType,
  DayStatus,
  SocketEvent,
  ZoneExitEndReason,
  type ZoneExitInfo,
} from '@suivi/shared';
import { In, IsNull, LessThanOrEqual } from 'typeorm';
import { User, WorkDay, Zone, ZoneExit } from '../entities';
import { AccessService } from './access.service';
import { AlertsService } from './alerts.service';
import { DbService } from './db.service';
import { NotificationsService } from './notifications.service';
import { RealtimeService, statusRooms } from './realtime.service';

/** Imprécision maximale prise en compte : au-delà, le point ne fait pas sortir l'agent. */
const MAX_ACCURACY_M = 100;

export interface ExitPoint {
  lat: number;
  lng: number;
  accuracy: number;
  recordedAt: Date;
}

/**
 * Sorties de zone d'un agent pendant sa journée.
 *
 * Deux seuils évitent les alertes qui clignotent en bordure :
 * - sortie : distance à la zone > tolérance + imprécision du point (plafonnée) ;
 * - retour : distance à la zone ≤ tolérance.
 * Le chef est prévenu quand la sortie dure plus que le délai d'alerte, puis au retour.
 */
@Injectable()
export class ZoneExitsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Suit les points d'un lot qui viennent d'être enregistrés. */
  async track(day: WorkDay, points: ExitPoint[]): Promise<void> {
    const zoneId = day.zoneId;
    if (!zoneId || !points.length) return;
    const m = this.db.manager;
    const settings = await this.access.settings();
    // Deux lots simultanés du même agent : traités l'un après l'autre.
    await m.query(`SELECT 1 FROM work_days WHERE id = $1 FOR UPDATE`, [day.id]);

    const sorted = [...points].sort(
      (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime(),
    );
    const distances = await m.query<{ d: number }[]>(
      `SELECT ST_Distance(z.area::geography,
                          ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography) AS d
       FROM jsonb_to_recordset($1::jsonb) AS p(i int, lat float8, lng float8)
       JOIN zones z ON z.id = $2
       ORDER BY p.i`,
      [
        JSON.stringify(sorted.map((p, i) => ({ i, lat: p.lat, lng: p.lng }))),
        zoneId,
      ],
    );
    if (distances.length !== sorted.length) return;

    let open: ZoneExit | null = await m.findOneBy(ZoneExit, {
      dayId: day.id,
      endedAt: IsNull(),
    });
    // Zone changée sans passer par la réaffectation : l'ancienne sortie n'a plus de sens.
    if (open && open.zoneId !== zoneId) {
      await this.close(
        open,
        sorted[0].recordedAt,
        ZoneExitEndReason.ZoneChanged,
      );
      open = null;
    }
    const wasAlerted = new Set(open?.alertedAt ? [open.id] : ([] as string[]));
    const touched: ZoneExit[] = [];
    const tolerance = settings.zoneExitToleranceMeters;

    for (const [i, point] of sorted.entries()) {
      const distance = Number(distances[i].d);
      if (!open) {
        const margin =
          tolerance + Math.min(Math.max(point.accuracy, 0), MAX_ACCURACY_M);
        if (distance <= margin) continue;
        open = m.create(ZoneExit, {
          tenantId: this.db.tenantId,
          dayId: day.id,
          agentId: day.agentId,
          zoneId,
          exitedAt: point.recordedAt,
          endedAt: null,
          endReason: null,
          maxDistanceM: Math.round(distance),
          alertedAt: null,
        });
        touched.push(open);
        continue;
      }
      if (point.recordedAt <= open.exitedAt) continue;
      if (!touched.includes(open)) touched.push(open);
      open.maxDistanceM = Math.max(open.maxDistanceM, Math.round(distance));
      if (distance <= tolerance) {
        open.endedAt = point.recordedAt;
        open.endReason = ZoneExitEndReason.Returned;
        open = null;
      }
    }
    if (!touched.length) return;
    await m.save(ZoneExit, touched);

    const last = sorted[sorted.length - 1].recordedAt;
    for (const exit of touched) {
      const until = exit.endedAt ?? last;
      const long =
        until.getTime() - exit.exitedAt.getTime() >=
        settings.zoneExitAlertMinutes * 60_000;
      if (!exit.alertedAt && long) await this.alert(exit);
      else if (wasAlerted.has(exit.id) && exit.endedAt)
        await this.announceReturn(exit);
      if (exit.endedAt)
        await this.alerts.resolve(
          exit.agentId,
          AlertType.OutOfZone,
          exit.endedAt,
        );
    }
  }

  /** Planificateur : sorties toujours en cours au-delà du délai, sans nouvelle position. */
  async alertOverdue(alertMinutes: number, now = new Date()): Promise<number> {
    const m = this.db.manager;
    const exits = await m.find(ZoneExit, {
      where: {
        endedAt: IsNull(),
        alertedAt: IsNull(),
        exitedAt: LessThanOrEqual(
          new Date(now.getTime() - alertMinutes * 60_000),
        ),
      },
    });
    if (!exits.length) return 0;
    const active = await m.findBy(WorkDay, {
      id: In(exits.map((e) => e.dayId)),
      status: In([DayStatus.Active, DayStatus.Paused]),
    });
    const ids = new Set(active.map((d) => d.id));
    let count = 0;
    for (const exit of exits.filter((e) => ids.has(e.dayId))) {
      await this.alert(exit, now);
      count++;
    }
    return count;
  }

  /** Fin de journée ou changement de zone : la sortie en cours est close. */
  async closeOpen(
    dayId: string,
    at: Date,
    reason: ZoneExitEndReason,
  ): Promise<void> {
    const open = await this.db.manager.findOneBy(ZoneExit, {
      dayId,
      endedAt: IsNull(),
    });
    if (open) await this.close(open, at, reason);
  }

  list(dayId: string): Promise<ZoneExit[]> {
    return this.db.manager.find(ZoneExit, {
      where: { dayId },
      order: { exitedAt: 'ASC' },
    });
  }

  /** Sorties en cours, par journée (carte en direct). */
  async openByDay(dayIds: string[]): Promise<Map<string, ZoneExit>> {
    if (!dayIds.length) return new Map();
    const exits = await this.db.manager.findBy(ZoneExit, {
      dayId: In(dayIds),
      endedAt: IsNull(),
    });
    return new Map(exits.map((e) => [e.dayId, e]));
  }

  private async close(exit: ZoneExit, at: Date, reason: ZoneExitEndReason) {
    exit.endedAt = at < exit.exitedAt ? exit.exitedAt : at;
    exit.endReason = reason;
    await this.db.manager.save(ZoneExit, exit);
    await this.alerts.resolve(exit.agentId, AlertType.OutOfZone, exit.endedAt);
    if (exit.alertedAt) await this.emit(exit);
  }

  private async alert(exit: ZoneExit, now = new Date()) {
    const m = this.db.manager;
    exit.alertedAt = now;
    await m.update(ZoneExit, { id: exit.id }, { alertedAt: now });
    const { agent, zone, recipients } = await this.context(exit);
    const minutes = durationMinutes(exit, now);
    const distance = formatDistance(exit.maxDistanceM);
    await this.notifications.notify(recipients, {
      type: 'zone_exit',
      title: `${agent.firstName} ${agent.lastName} : hors zone`,
      body: exit.endedAt
        ? `${minutes} min hors de la zone ${zone.name}, jusqu’à ${distance}. Revenu(e) depuis.`
        : `Hors de la zone ${zone.name} depuis ${minutes} min, à ${distance}.`,
      data: {
        exitId: exit.id,
        agentId: exit.agentId,
        dayId: exit.dayId,
        zoneId: exit.zoneId,
      },
    });
    // Centre d'alertes du responsable (déjà prévenu ci-dessus).
    await this.alerts.open(
      agent,
      AlertType.OutOfZone,
      exit.dayId,
      {
        exitId: exit.id,
        zoneId: exit.zoneId,
        zoneName: zone.name,
        maxDistanceM: exit.maxDistanceM,
      },
      { notify: false, at: exit.exitedAt },
    );
    if (exit.endedAt)
      await this.alerts.resolve(
        exit.agentId,
        AlertType.OutOfZone,
        exit.endedAt,
      );
    await this.emit(exit);
  }

  private async announceReturn(exit: ZoneExit) {
    const { agent, zone, recipients } = await this.context(exit);
    await this.notifications.notify(recipients, {
      type: 'zone_exit.returned',
      title: `${agent.firstName} ${agent.lastName} : retour dans la zone`,
      body: `De retour dans la zone ${zone.name} après ${durationMinutes(exit)} min dehors.`,
      data: {
        exitId: exit.id,
        agentId: exit.agentId,
        dayId: exit.dayId,
        zoneId: exit.zoneId,
      },
    });
    await this.emit(exit);
  }

  private async context(exit: ZoneExit) {
    const m = this.db.manager;
    const agent = await m.findOneByOrFail(User, { id: exit.agentId });
    const zone = await m.findOneByOrFail(Zone, { id: exit.zoneId });
    const settings = await this.access.settings();
    const recipients = await this.access.approverIds(agent, settings);
    return { agent, zone, recipients };
  }

  private async emit(exit: ZoneExit) {
    const agent = await this.db.manager.findOneByOrFail(User, {
      id: exit.agentId,
    });
    const tenantId = this.db.tenantId;
    const payload = toInfo(exit);
    this.db.afterCommit(() =>
      this.realtime.emit(
        statusRooms(tenantId, agent),
        SocketEvent.AgentZoneExit,
        payload,
      ),
    );
  }
}

export function toInfo(exit: ZoneExit): ZoneExitInfo {
  return {
    id: exit.id,
    dayId: exit.dayId,
    agentId: exit.agentId,
    zoneId: exit.zoneId,
    exitedAt: exit.exitedAt.toISOString(),
    endedAt: exit.endedAt?.toISOString() ?? null,
    endReason: exit.endReason,
    maxDistanceM: exit.maxDistanceM,
    alertedAt: exit.alertedAt?.toISOString() ?? null,
  };
}

function durationMinutes(exit: ZoneExit, now = new Date()): number {
  const end = exit.endedAt ?? now;
  return Math.max(
    1,
    Math.round((end.getTime() - exit.exitedAt.getTime()) / 60_000),
  );
}

function formatDistance(meters: number): string {
  if (meters >= 1000)
    return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
  return `environ ${Math.max(10, Math.round(meters / 10) * 10)} m`;
}
