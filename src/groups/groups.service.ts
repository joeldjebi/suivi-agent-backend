import { Injectable } from '@nestjs/common';
import { Role } from '@suivi/shared';
import { In } from 'typeorm';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest, forbidden, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import {
  assertDeletable,
  countSql,
  describeImpact,
  type Impact,
} from '../common/deletion';
import { Group, User, Zone } from '../entities';
import { CreateGroupDto, UpdateGroupDto } from './groups.dto';

@Injectable()
export class GroupsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  async list(user: AuthUser, includeInactive = false) {
    const m = this.db.manager;
    const where = {
      ...(user.role === Role.Admin ? {} : { leaderId: user.id }),
      ...(includeInactive ? {} : { isActive: true }),
    };
    const groups = await m.find(Group, { where, order: { name: 'ASC' } });
    if (!groups.length) return [];
    const counts = await m.query<{ group_id: string; agents: number }[]>(
      `SELECT group_id, count(*)::int AS agents FROM users
       WHERE group_id = ANY($1) AND is_active GROUP BY group_id`,
      [groups.map((g) => g.id)],
    );
    return groups.map((g) => ({
      ...g,
      agentCount: counts.find((c) => c.group_id === g.id)?.agents ?? 0,
    }));
  }

  async get(user: AuthUser, id: string) {
    const m = this.db.manager;
    const group = await m.findOneBy(Group, { id });
    if (!group) throw notFound('Groupe');
    if (user.role === Role.TeamLead && group.leaderId !== user.id)
      throw forbidden();
    const members = await m.find(User, {
      where: { groupId: id },
      order: { lastName: 'ASC' },
    });
    return { ...group, members, zones: await this.zonesOf(id) };
  }

  async create(dto: CreateGroupDto): Promise<Group> {
    await this.assertLeader(dto.leaderId);
    return this.db.manager.save(Group, {
      tenantId: this.db.tenantId,
      name: dto.name,
      leaderId: dto.leaderId ?? null,
    });
  }

  async update(id: string, dto: UpdateGroupDto): Promise<Group> {
    const m = this.db.manager;
    if (!(await m.existsBy(Group, { id }))) throw notFound('Groupe');
    await this.assertLeader(dto.leaderId);
    await m.update(Group, { id }, dto);
    return m.findOneByOrFail(Group, { id });
  }

  /** Ce qu'une suppression définitive emporterait. */
  async impact(id: string): Promise<Impact> {
    if (!(await this.db.manager.existsBy(Group, { id })))
      throw notFound('Groupe');
    const [row] = await this.db.manager.query<Impact[]>(
      `SELECT ${countSql('users', 'group_id')} AS agents,
              ${countSql('missions', 'assignee_group_id')} AS missions,
              ${countSql('group_zones', 'group_id')} AS zones`,
      [id],
    );
    return row;
  }

  /**
   * Suppression définitive : les missions du groupe sont supprimées, ses agents
   * ne sont plus rattachés à aucun groupe.
   */
  async remove(id: string, force?: boolean): Promise<void> {
    assertDeletable(await this.impact(id), force);
    await this.db.manager.delete(Group, { id });
  }

  async describeImpact(id: string) {
    return describeImpact(await this.impact(id));
  }

  /** Remplace les membres du groupe ; un agent ne peut appartenir qu'à un seul groupe. */
  async setMembers(id: string, agentIds: string[]) {
    const m = this.db.manager;
    if (!(await m.existsBy(Group, { id }))) throw notFound('Groupe');
    const agents = agentIds.length
      ? await m.findBy(User, { id: In(agentIds) })
      : [];
    if (
      agents.length !== agentIds.length ||
      agents.some((a) => a.role !== Role.Agent)
    ) {
      throw badRequest(
        'INVALID_AGENTS',
        'Tous les membres doivent être des agents existants',
      );
    }
    await m.query(
      `UPDATE users SET group_id = NULL WHERE group_id = $1 AND NOT (id = ANY($2))`,
      [id, agentIds],
    );
    if (agentIds.length)
      await m.update(User, { id: In(agentIds) }, { groupId: id });
    return m.find(User, { where: { groupId: id }, order: { lastName: 'ASC' } });
  }

  /** Zones attribuées au groupe (RG-06). */
  async setZones(id: string, zoneIds: string[]) {
    const m = this.db.manager;
    if (!(await m.existsBy(Group, { id }))) throw notFound('Groupe');
    if (
      zoneIds.length &&
      (await m.countBy(Zone, { id: In(zoneIds) })) !== zoneIds.length
    ) {
      throw notFound('Zone');
    }
    await m.query(`DELETE FROM group_zones WHERE group_id = $1`, [id]);
    if (zoneIds.length) {
      await m.query(
        `INSERT INTO group_zones (group_id, zone_id, tenant_id) SELECT $1, unnest($2::uuid[]), $3`,
        [id, zoneIds, this.db.tenantId],
      );
    }
    return this.zonesOf(id);
  }

  private zonesOf(groupId: string): Promise<Zone[]> {
    return this.db.manager
      .createQueryBuilder(Zone, 'z')
      .innerJoin('group_zones', 'gz', 'gz.zone_id = z.id')
      .where('gz.group_id = :groupId', { groupId })
      .orderBy('z.name')
      .getMany();
  }

  private async assertLeader(leaderId: string | null | undefined) {
    if (!leaderId) return;
    const leader = await this.db.manager.findOneBy(User, { id: leaderId });
    if (!leader) throw notFound("Chef d'équipe");
    if (leader.role !== Role.TeamLead) {
      throw badRequest(
        'INVALID_LEADER',
        "Le chef d'équipe doit avoir le rôle team_lead",
      );
    }
  }
}
