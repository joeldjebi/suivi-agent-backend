import { Injectable } from '@nestjs/common';
import { Role, ZoneRequestStatus } from '@suivi/shared';
import { In } from 'typeorm';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest, conflict, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import {
  assertDeletable,
  countSql,
  describeImpact,
  type Impact,
} from '../common/deletion';
import { NotificationsService } from '../common/notifications.service';
import { MissionsService } from '../missions/missions.service';
import { TenantSettings, User, Zone, ZoneRequest } from '../entities';
import { CreateZoneDto, PolygonDto, UpdateZoneDto } from './zones.dto';

export interface ZoneWithOccupancy extends Zone {
  /** Groupes actifs de la zone ; vide : zone libre */
  groupIds: string[];
  /** Places réservées (demandes en attente) et occupées (demandes approuvées) */
  taken: number;
  /** Places restantes ; null si la zone est illimitée */
  placesLeft: number | null;
  isFull: boolean;
}

@Injectable()
export class ZonesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly missions: MissionsService,
  ) {}

  async list(
    user: AuthUser,
    includeInactive = false,
  ): Promise<ZoneWithOccupancy[]> {
    const qb = this.db.manager.createQueryBuilder(Zone, 'z').orderBy('z.name');
    if (!includeInactive) qb.andWhere('z.isActive');
    if (
      user.role === Role.TeamLead &&
      !(await this.access.supervisesAll(user))
    ) {
      // Les zones de ses groupes, plus les zones libres (rattachées à aucun groupe).
      const groupIds = await this.access.leaderGroupIds(user.id);
      qb.andWhere(
        `(EXISTS (SELECT 1 FROM group_zones gz WHERE gz.zone_id = z.id AND gz.group_id = ANY(:groupIds))
          OR NOT EXISTS (SELECT 1 FROM group_zones gz JOIN groups g ON g.id = gz.group_id AND g.is_active
                         WHERE gz.zone_id = z.id))`,
        { groupIds },
      );
    }
    return this.withOccupancy(await qb.getMany());
  }

  async get(id: string): Promise<ZoneWithOccupancy> {
    const zone = await this.db.manager.findOneBy(Zone, { id });
    if (!zone) throw notFound('Zone');
    const [result] = await this.withOccupancy([zone]);
    return result;
  }

  /** Zones que l'agent peut choisir (RG-06, RG-15, RG-33), avec les places restantes. */
  async availableFor(user: AuthUser) {
    const agentId = user.id;
    const settings = await this.access.settings();
    const agent = await this.access.getAgent(agentId);
    const zoneIds = await this.accessibleZoneIds(agent, settings);
    const zones = zoneIds.length
      ? await this.db.manager.find(Zone, {
          where: { id: In(zoneIds) },
          order: { name: 'ASC' },
        })
      : [];
    const current = await this.db.manager.find(ZoneRequest, {
      where: {
        agentId,
        status: In([ZoneRequestStatus.Pending, ZoneRequestStatus.Approved]),
      },
    });
    const withOccupancy = await this.withOccupancy(zones);
    // Les missions de chaque zone, pour choisir en connaissance de cause.
    const missions = await this.missions.forZones(
      user,
      zones.map((z) => z.id),
    );
    return {
      zones: withOccupancy.map((zone) => ({
        ...zone,
        mine: current.find((r) => r.zoneId === zone.id)?.status ?? null,
        missions: missions.get(zone.id) ?? [],
      })),
      approved:
        current.find((r) => r.status === ZoneRequestStatus.Approved) ?? null,
      pending:
        current.find((r) => r.status === ZoneRequestStatus.Pending) ?? null,
      groupMissing: settings.useGroups && !agent.groupId,
    };
  }

  /** Voir AccessService.accessibleZoneIds (règle commune aux zones et aux missions). */
  accessibleZoneIds(agent: User, settings: TenantSettings): Promise<string[]> {
    return this.access.accessibleZoneIds(agent, settings);
  }

  async create(dto: CreateZoneDto): Promise<ZoneWithOccupancy> {
    await this.assertArea(dto.area);
    const zone = await this.db.manager.save(Zone, {
      tenantId: this.db.tenantId,
      name: dto.name,
      area: dto.area,
      capacity: dto.capacity ?? null,
      sensitive: dto.sensitive ?? false,
      restricted: dto.restricted ?? false,
      isActive: true,
    });
    return this.get(zone.id);
  }

  async update(id: string, dto: UpdateZoneDto): Promise<ZoneWithOccupancy> {
    const m = this.db.manager;
    const zone = await m.findOneBy(Zone, { id });
    if (!zone) throw notFound('Zone');
    const { isActive, ...fields } = dto;
    // Réouverture : la zone ne doit pas chevaucher une zone active entre-temps.
    if (dto.area || (isActive && !zone.isActive)) {
      await this.assertArea(dto.area ?? zone.area, id);
    }
    if (Object.keys(fields).length) await m.update(Zone, { id }, fields);
    if (isActive === false && zone.isActive) await this.deactivate(zone);
    if (isActive && !zone.isActive)
      await m.update(Zone, { id }, { isActive: true });
    return this.get(id);
  }

  /** Ce qu'une suppression définitive emporterait. */
  async impact(id: string): Promise<Impact> {
    if (!(await this.db.manager.existsBy(Zone, { id }))) throw notFound('Zone');
    const [row] = await this.db.manager.query<Impact[]>(
      `SELECT ${countSql('zone_requests', 'zone_id')} AS requests,
              ${countSql('work_days', 'zone_id')} AS days,
              ${countSql('group_zones', 'zone_id')} AS groups`,
      [id],
    );
    return row;
  }

  async describeImpact(id: string) {
    return describeImpact(await this.impact(id));
  }

  /**
   * Suppression définitive : l'historique des demandes de la zone est supprimé,
   * les journées passées perdent leur zone. Les agents qui l'occupaient sont prévenus.
   */
  async remove(id: string, force?: boolean): Promise<void> {
    assertDeletable(await this.impact(id), force);
    const zone = await this.db.manager.findOneByOrFail(Zone, { id });
    if (zone.isActive) await this.deactivate(zone);
    await this.db.manager.delete(Zone, { id });
  }

  /** Ferme la zone (l'historique est conservé) et libère ses places. */
  private async deactivate(zone: Zone): Promise<void> {
    const m = this.db.manager;
    const id = zone.id;
    await m.update(Zone, { id }, { isActive: false });
    const seats = await m.find(ZoneRequest, {
      where: {
        zoneId: id,
        status: In([ZoneRequestStatus.Pending, ZoneRequestStatus.Approved]),
      },
    });
    if (!seats.length) return;
    await m.query(
      `UPDATE zone_requests
       SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE 'released' END,
           released_at = now(), release_reason = 'zone_deactivated'
       WHERE zone_id = $1 AND status IN ('pending', 'approved')`,
      [id],
    );
    await this.notifications.notify(
      seats.map((s) => s.agentId),
      {
        type: 'zone.deactivated',
        title: 'Zone fermée',
        body: `La zone ${zone.name} a été fermée. Choisissez une autre zone.`,
        data: { zoneId: id },
      },
    );
  }

  /** Agents autorisés sur une zone réservée (RG-15). */
  async setAgents(id: string, agentIds: string[]) {
    const m = this.db.manager;
    if (!(await m.existsBy(Zone, { id }))) throw notFound('Zone');
    const agents = agentIds.length
      ? await m.findBy(User, { id: In(agentIds), role: Role.Agent })
      : [];
    if (agents.length !== agentIds.length) {
      throw badRequest(
        'INVALID_AGENTS',
        'Tous les identifiants doivent désigner des agents',
      );
    }
    await m.query(`DELETE FROM zone_agent_access WHERE zone_id = $1`, [id]);
    if (agentIds.length) {
      await m.query(
        `INSERT INTO zone_agent_access (zone_id, agent_id, tenant_id) SELECT $1, unnest($2::uuid[]), $3`,
        [id, agentIds, this.db.tenantId],
      );
    }
    return agents;
  }

  async listAgents(id: string): Promise<User[]> {
    if (!(await this.db.manager.existsBy(Zone, { id }))) throw notFound('Zone');
    return this.db.manager
      .createQueryBuilder(User, 'u')
      .innerJoin('zone_agent_access', 'a', 'a.agent_id = u.id')
      .where('a.zone_id = :id', { id })
      .orderBy('u.lastName')
      .getMany();
  }

  async withOccupancy(zones: Zone[]): Promise<ZoneWithOccupancy[]> {
    if (!zones.length) return [];
    const rows = await this.db.manager.query<
      { zone_id: string; taken: number }[]
    >(
      `SELECT zone_id, count(*)::int AS taken FROM zone_requests
       WHERE zone_id = ANY($1) AND status IN ('pending', 'approved') GROUP BY zone_id`,
      [zones.map((z) => z.id)],
    );
    // Groupes actifs de chaque zone : sans groupe, la zone est libre.
    const groups = await this.db.manager.query<
      { zone_id: string; group_id: string }[]
    >(
      `SELECT gz.zone_id, gz.group_id FROM group_zones gz
       JOIN groups g ON g.id = gz.group_id AND g.is_active
       WHERE gz.zone_id = ANY($1)`,
      [zones.map((z) => z.id)],
    );
    return zones.map((zone) => {
      const taken = rows.find((r) => r.zone_id === zone.id)?.taken ?? 0;
      const placesLeft =
        zone.capacity === null ? null : Math.max(zone.capacity - taken, 0);
      return {
        ...zone,
        taken,
        placesLeft,
        isFull: placesLeft === 0,
        groupIds: groups
          .filter((g) => g.zone_id === zone.id)
          .map((g) => g.group_id),
      };
    });
  }

  /** Polygone valide et sans chevauchement avec une autre zone active. */
  private async assertArea(area: PolygonDto, excludeId?: string) {
    const ringsValid =
      Array.isArray(area.coordinates) &&
      area.coordinates.length > 0 &&
      area.coordinates.every(
        (ring) =>
          Array.isArray(ring) &&
          ring.length >= 4 &&
          ring.every(
            (p) =>
              Array.isArray(p) &&
              p.length >= 2 &&
              Math.abs(p[0]) <= 180 &&
              Math.abs(p[1]) <= 90,
          ),
      );
    if (!ringsValid)
      throw badRequest('INVALID_AREA', 'Polygone GeoJSON invalide');

    const geojson = JSON.stringify(area);
    const [{ valid }] = await this.db.manager.query<{ valid: boolean }[]>(
      `SELECT ST_IsValid(ST_GeomFromGeoJSON($1)) AS valid`,
      [geojson],
    );
    if (!valid)
      throw badRequest(
        'INVALID_AREA',
        'Le polygone se recoupe ou n’est pas fermé',
      );

    const overlapping = await this.db.manager.query<{ name: string }[]>(
      `SELECT name FROM zones
       WHERE is_active AND ($2::uuid IS NULL OR id <> $2)
         AND ST_Intersects(area, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))
         AND NOT ST_Touches(area, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))
       LIMIT 1`,
      [geojson, excludeId ?? null],
    );
    if (overlapping.length) {
      throw conflict(
        'ZONE_OVERLAP',
        `La zone chevauche la zone « ${overlapping[0].name} »`,
      );
    }
  }
}
