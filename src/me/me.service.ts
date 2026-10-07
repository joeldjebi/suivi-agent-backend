import { Injectable } from '@nestjs/common';
import { Role } from '@suivi/shared';
import { In } from 'typeorm';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { DbService } from '../common/db.service';
import { Group, User, Zone } from '../entities';
import { ZonesService } from '../zones/zones.service';

export interface TeamLeadInfo {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
}

/**
 * Ce que l'agent sait de son équipe : son groupe, son ou ses chefs (à appeler) et les
 * zones qu'il peut choisir. Sans groupes, les chefs suivent toute la structure.
 */
@Injectable()
export class MeService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly zones: ZonesService,
  ) {}

  async team(user: AuthUser) {
    const m = this.db.manager;
    const settings = await this.access.settings();
    const agent = await this.access.getAgent(user.id);
    const group =
      settings.useGroups && agent.groupId
        ? await m.findOneBy(Group, { id: agent.groupId, isActive: true })
        : null;

    let leads: User[] = [];
    if (settings.useGroups) {
      if (group?.leaderId)
        leads = await m.findBy(User, {
          id: group.leaderId,
          isActive: true,
        });
    } else {
      leads = await m.find(User, {
        where: { role: Role.TeamLead, isActive: true },
        order: { firstName: 'ASC' },
      });
    }

    const zoneIds = await this.zones.accessibleZoneIds(agent, settings);
    const zones = zoneIds.length
      ? await m.find(Zone, {
          where: { id: In(zoneIds) },
          order: { name: 'ASC' },
        })
      : [];
    const [{ members }] = group
      ? await m.query<{ members: number }[]>(
          `SELECT count(*)::int AS members FROM users WHERE group_id = $1 AND role = 'agent' AND is_active`,
          [group.id],
        )
      : [{ members: 0 }];

    return {
      usesGroups: settings.useGroups,
      group: group ? { id: group.id, name: group.name, members } : null,
      /** Rattaché à aucun groupe alors que la structure en utilise : aucune zone possible. */
      groupMissing: settings.useGroups && !group,
      leads: leads.map((l): TeamLeadInfo => ({
        id: l.id,
        firstName: l.firstName,
        lastName: l.lastName,
        phone: l.phone,
      })),
      zones: zones.map((z) => ({
        id: z.id,
        name: z.name,
        capacity: z.capacity,
      })),
    };
  }
}
