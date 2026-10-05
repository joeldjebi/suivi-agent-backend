import { Injectable } from '@nestjs/common';
import { ApprovalMode, Feature, Role } from '@suivi/shared';
import { In } from 'typeorm';
import { Group, TenantSettings, User } from '../entities';
import type { AuthUser } from './auth-user';
import { forbidden, notFound } from './business.exception';
import { DbService } from './db.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

/** Périmètre de chaque rôle : l'administrateur voit tout, le chef d'équipe ses groupes. */
@Injectable()
export class AccessService {
  constructor(
    private readonly db: DbService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /**
   * Réglages en vigueur : ceux de la structure, limités par sa formule. Sans l'avantage
   * « groupes », les groupes sont désactivés ; sans « validation des zones », elle est
   * automatique. Les réglages enregistrés reprennent effet si la formule les inclut à nouveau.
   */
  async settings(): Promise<TenantSettings> {
    const tenantId = this.db.tenantId;
    const settings = await this.db.manager.findOneByOrFail(TenantSettings, {
      tenantId,
    });
    return effectiveSettings(
      settings,
      (await this.subscriptions.summary(tenantId)).features,
    );
  }

  /** La formule de la structure inclut-elle les groupes ? */
  private async groupsInPlan(): Promise<boolean> {
    const { features } = await this.subscriptions.summary(this.db.tenantId);
    return features.includes(Feature.Groups);
  }

  /**
   * Chef d'équipe d'une formule sans groupes (ex. Base, « 1 chef et 10 agents ») :
   * il supervise toute la structure, sinon il n'aurait aucun agent.
   */
  async supervisesAll(user: Pick<AuthUser, 'role'>): Promise<boolean> {
    return user.role === Role.TeamLead && !(await this.groupsInPlan());
  }

  async leaderGroupIds(userId: string): Promise<string[]> {
    const groups = await this.db.manager.find(Group, {
      select: { id: true },
      where: { leaderId: userId, isActive: true },
    });
    return groups.map((g) => g.id);
  }

  /** Identifiants des agents visibles par l'utilisateur ; `null` signifie « tous ». */
  async agentScope(user: AuthUser): Promise<string[] | null> {
    if (user.role === Role.Admin) return null;
    if (user.role === Role.Agent) return [user.id];
    // Sans groupes : tous les agents de la structure (jamais les administrateurs).
    if (await this.supervisesAll(user)) {
      const agents = await this.db.manager.find(User, {
        select: { id: true },
        where: { role: Role.Agent },
      });
      return agents.map((a) => a.id);
    }
    const groupIds = await this.leaderGroupIds(user.id);
    if (!groupIds.length) return [];
    const agents = await this.db.manager.find(User, {
      select: { id: true },
      where: { groupId: In(groupIds), role: Role.Agent },
    });
    return agents.map((a) => a.id);
  }

  async getAgent(agentId: string): Promise<User> {
    const agent = await this.db.manager.findOneBy(User, {
      id: agentId,
      role: Role.Agent,
    });
    if (!agent) throw notFound('Agent');
    return agent;
  }

  /** Vérifie que l'utilisateur peut gérer cet agent et le renvoie. */
  async assertCanManageAgent(user: AuthUser, agentId: string): Promise<User> {
    const agent = await this.getAgent(agentId);
    if (user.role === Role.Admin) return agent;
    if (await this.supervisesAll(user)) return agent;
    if (user.role === Role.TeamLead && agent.groupId) {
      const groupIds = await this.leaderGroupIds(user.id);
      if (groupIds.includes(agent.groupId)) return agent;
    }
    throw forbidden("Cet agent n'est pas dans votre périmètre");
  }

  async adminIds(): Promise<string[]> {
    const admins = await this.db.manager.find(User, {
      select: { id: true },
      where: { role: Role.Admin, isActive: true },
    });
    return admins.map((a) => a.id);
  }

  /**
   * Qui approuve les demandes d'un agent : le chef de son groupe si les groupes
   * sont activés et que le groupe a un chef, sinon les administrateurs (RG-16, RG-34).
   * Formule sans groupes : les chefs d'équipe actifs supervisent toute la structure, ils
   * approuvent aussi, avec les administrateurs.
   */
  async approverIds(agent: User, settings: TenantSettings): Promise<string[]> {
    if (settings.useGroups && agent.groupId) {
      const group = await this.db.manager.findOneBy(Group, {
        id: agent.groupId,
      });
      if (group?.isActive && group.leaderId) return [group.leaderId];
    }
    if (await this.groupsInPlan()) return this.adminIds();
    const supervisors = await this.db.manager.find(User, {
      select: { id: true },
      where: { role: In([Role.Admin, Role.TeamLead]), isActive: true },
    });
    return supervisors.map((u) => u.id);
  }
}

/** Réglages limités aux avantages de la formule (voir AccessService.settings). */
export function effectiveSettings(
  settings: TenantSettings,
  features: Feature[],
): TenantSettings {
  const effective = Object.assign(new TenantSettings(), settings);
  if (!features.includes(Feature.Groups)) effective.useGroups = false;
  if (!features.includes(Feature.ManualApproval))
    effective.approvalMode = ApprovalMode.Automatic;
  return effective;
}
