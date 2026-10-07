import { Injectable } from '@nestjs/common';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { Role } from '@suivi/shared';
import { IsNull } from 'typeorm';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest, forbidden, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { requirePhone } from '../common/phone';
import { SessionRevocationService } from '../common/session-revocation.service';
import {
  assertDeletable,
  countSql,
  describeImpact,
  type Impact,
} from '../common/deletion';
import { AuthService, hashPassword } from '../auth/auth.service';
import { Group, RefreshToken, User } from '../entities';
import { CreateUserDto, ListUsersQuery, UpdateUserDto } from './users.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly auth: AuthService,
    private readonly revocation: SessionRevocationService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async list(user: AuthUser, query: ListUsersQuery) {
    const qb = this.db.manager.createQueryBuilder(User, 'u');
    const lastDay = `(SELECT max(d.work_date) FROM work_days d WHERE d.agent_id = u.id)`;
    if (query.sort === 'recent') qb.orderBy('u.createdAt', 'DESC');
    else if (query.sort === 'lastDay')
      qb.orderBy(lastDay, 'DESC', 'NULLS LAST');
    else qb.orderBy('u.lastName').addOrderBy('u.firstName');
    const scope = await this.access.agentScope(user);
    if (scope)
      qb.andWhere('u.id IN (:...scope)', {
        scope: scope.length ? scope : [null],
      });
    if (query.role) qb.andWhere('u.role = :role', { role: query.role });
    if (query.groupId)
      qb.andWhere('u.groupId = :groupId', { groupId: query.groupId });
    if (query.search) {
      const digits = query.search.replace(/\D/g, '');
      qb.andWhere(
        `(u.firstName || ' ' || u.lastName ILIKE :search OR u.lastName || ' ' || u.firstName ILIKE :search
          OR u.email ILIKE :search ${digits.length >= 3 ? 'OR u.phone LIKE :digits' : ''})`,
        { search: `%${query.search.trim()}%`, digits: `%${digits}%` },
      );
    }
    if (query.status === 'active') qb.andWhere('u.isActive');
    if (query.status === 'inactive') qb.andWhere('NOT u.isActive');
    if (query.status === 'probation') qb.andWhere('u.onProbation');
    if (query.withoutGroup)
      qb.andWhere(`u.role = 'agent' AND u.groupId IS NULL`);
    if (query.activity === 'working')
      qb.andWhere(
        `EXISTS (SELECT 1 FROM work_days d WHERE d.agent_id = u.id AND d.status IN ('active', 'paused'))`,
      );
    if (query.activity === 'never')
      qb.andWhere(
        `u.role = 'agent' AND NOT EXISTS (SELECT 1 FROM work_days d WHERE d.agent_id = u.id)`,
      );
    if (query.activity === 'idle30')
      qb.andWhere(
        `u.role = 'agent' AND NOT EXISTS (SELECT 1 FROM work_days d WHERE d.agent_id = u.id AND d.work_date >= current_date - 30)`,
      );
    const [users, total] = await qb
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return {
      items: await this.withActivity(users),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /** Activité récente de chaque utilisateur de la page : journées, connexions. */
  private async withActivity(users: User[]) {
    if (!users.length) return [];
    const rows = await this.db.manager.query<
      {
        id: string;
        lastDay: string | null;
        days30: number;
        working: boolean;
        lastLoginAt: Date | null;
      }[]
    >(
      `SELECT u.id,
              to_char((SELECT max(work_date) FROM work_days WHERE agent_id = u.id), 'YYYY-MM-DD') AS "lastDay",
              (SELECT count(*)::int FROM work_days WHERE agent_id = u.id AND work_date >= current_date - 30) AS days30,
              EXISTS (SELECT 1 FROM work_days WHERE agent_id = u.id AND status IN ('active', 'paused')) AS working,
              (SELECT max(created_at) FROM audit_logs WHERE user_id = u.id AND action = 'auth.login') AS "lastLoginAt"
       FROM users u WHERE u.id = ANY($1::uuid[])`,
      [users.map((u) => u.id)],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return users.map((u) => {
      const r = byId.get(u.id);
      return {
        ...u,
        lastDay: r?.lastDay ?? null,
        days30: r?.days30 ?? 0,
        working: r?.working ?? false,
        lastLoginAt: r?.lastLoginAt ?? null,
      };
    });
  }

  /** Chiffres de la page Utilisateurs (périmètre du chef d'équipe pour un chef). */
  async stats(user: AuthUser) {
    const scope = await this.access.agentScope(user);
    const [row] = await this.db.manager.query<Record<string, number>[]>(
      `SELECT
         count(*) FILTER (WHERE u.role = 'agent')::int AS agents,
         count(*) FILTER (WHERE u.role = 'team_lead')::int AS "teamLeads",
         count(*) FILTER (WHERE u.role = 'admin')::int AS admins,
         count(*) FILTER (WHERE u.is_active)::int AS active,
         count(*) FILTER (WHERE NOT u.is_active)::int AS inactive,
         count(*) FILTER (WHERE u.on_probation AND u.is_active)::int AS probation,
         count(*) FILTER (WHERE u.role = 'agent' AND u.is_active AND u.group_id IS NULL)::int AS "withoutGroup",
         count(*) FILTER (WHERE u.role = 'agent' AND u.is_active AND EXISTS (
           SELECT 1 FROM work_days d WHERE d.agent_id = u.id AND d.status IN ('active', 'paused')))::int AS working,
         count(*) FILTER (WHERE u.role = 'agent' AND u.is_active AND NOT EXISTS (
           SELECT 1 FROM work_days d WHERE d.agent_id = u.id))::int AS never,
         count(*) FILTER (WHERE u.role = 'agent' AND u.is_active AND EXISTS (
           SELECT 1 FROM work_days d WHERE d.agent_id = u.id) AND NOT EXISTS (
           SELECT 1 FROM work_days d WHERE d.agent_id = u.id AND d.work_date >= current_date - 30))::int AS idle30,
         count(*) FILTER (WHERE u.created_at >= date_trunc('month', now()))::int AS "createdThisMonth"
       FROM users u
       WHERE ($1::uuid[] IS NULL OR u.id = ANY($1::uuid[]))`,
      [scope],
    );
    // Quotas de la formule (administrateur) : affichés à côté des compteurs.
    const quota =
      user.role === Role.Admin ? await this.subscriptions.quota() : null;
    return { ...row, quota };
  }

  async get(user: AuthUser, id: string): Promise<User> {
    if (user.role !== Role.Admin && user.id !== id) {
      return this.access.assertCanManageAgent(user, id);
    }
    const found = await this.db.manager.findOneBy(User, { id });
    if (!found) throw notFound('Utilisateur');
    return found;
  }

  async avatar(
    user: AuthUser,
    id: string,
  ): Promise<{ data: Buffer; mime: string; version: number }> {
    await this.get(user, id);
    const [row] = await this.db.manager.query<
      {
        avatar: Buffer | null;
        avatar_mime: string | null;
        avatar_version: number | null;
      }[]
    >(`SELECT avatar, avatar_mime, avatar_version FROM users WHERE id = $1`, [
      id,
    ]);
    if (!row?.avatar || !row.avatar_mime) throw notFound('Photo');
    return {
      data: row.avatar,
      mime: row.avatar_mime,
      version: row.avatar_version ?? 0,
    };
  }

  async create(dto: CreateUserDto): Promise<User> {
    await this.subscriptions.assertQuota(dto.role);
    await this.auth.assertEmailFree(dto.email);
    await this.assertGroup(dto.role, dto.groupId);
    const phone = await this.checkPhone(dto.role, dto.phone);
    const created = await this.db.manager.save(User, {
      tenantId: this.db.tenantId,
      email: dto.email.toLowerCase(),
      passwordHash: await hashPassword(dto.password),
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone,
      role: dto.role,
      groupId: dto.role === Role.Agent ? (dto.groupId ?? null) : null,
      onProbation: dto.onProbation ?? false,
      workdayMinutes: dto.workdayMinutes ?? null,
      isActive: true,
    });
    return this.db.manager.findOneByOrFail(User, { id: created.id });
  }

  async update(
    current: AuthUser,
    id: string,
    dto: UpdateUserDto,
  ): Promise<User> {
    const m = this.db.manager;
    const existing = await m.findOneBy(User, { id });
    if (!existing) throw notFound('Utilisateur');
    if (
      id === current.id &&
      ((dto.role && dto.role !== Role.Admin) || dto.isActive === false)
    ) {
      throw forbidden(
        'Vous ne pouvez pas retirer vos propres droits administrateur',
      );
    }
    if (dto.email && dto.email.toLowerCase() !== existing.email) {
      await this.auth.assertEmailFree(dto.email);
    }
    const role = dto.role ?? existing.role;
    // Un compte qui (re)devient actif, ou qui change de rôle, compte dans le quota de la formule.
    const active = dto.isActive ?? existing.isActive;
    if (active && (!existing.isActive || role !== existing.role))
      await this.subscriptions.assertQuota(role);
    const groupId = dto.groupId === undefined ? existing.groupId : dto.groupId;
    await this.assertGroup(role, groupId);
    const phone = await this.checkPhone(
      role,
      dto.phone === undefined ? existing.phone : dto.phone,
      id,
    );

    // `phone` (normalisé) est placé après `...fields` et remplace la valeur saisie.
    const { password, ...fields } = dto;
    await m.update(
      User,
      { id },
      {
        ...fields,
        ...(dto.email ? { email: dto.email.toLowerCase() } : {}),
        ...(password ? { passwordHash: await hashPassword(password) } : {}),
        phone,
        groupId: role === Role.Agent ? groupId : null,
      },
    );
    // Désactivation, nouveau mot de passe ou nouveau rôle : l'accès est coupé tout de suite.
    if (
      dto.isActive === false ||
      password ||
      (dto.role && dto.role !== existing.role)
    ) {
      await this.revocation.revoke(id);
    }
    if (dto.isActive === false || password) {
      await m.update(
        RefreshToken,
        { userId: id, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
    }
    if (dto.isActive === false && existing.isActive) {
      // Un compte désactivé ne garde aucune place dans les zones.
      await m.query(
        `UPDATE zone_requests
         SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE 'released' END,
             released_at = now(), release_reason = 'user_deactivated'
         WHERE agent_id = $1 AND status IN ('pending', 'approved')`,
        [id],
      );
    }
    return m.findOneByOrFail(User, { id });
  }

  /** Ce qu'une suppression définitive emporterait. */
  async impact(id: string): Promise<Impact> {
    if (!(await this.db.manager.existsBy(User, { id })))
      throw notFound('Utilisateur');
    const [row] = await this.db.manager.query<Impact[]>(
      `SELECT ${countSql('work_days', 'agent_id')} AS days,
              ${countSql('positions', 'agent_id')} AS positions,
              ${countSql('mission_submissions', 'agent_id')} AS submissions,
              ${countSql('missions', 'assignee_agent_id')} AS missions,
              ${countSql('groups', 'leader_id')} AS ledGroups`,
      [id],
    );
    return row;
  }

  async describeImpact(id: string) {
    return describeImpact(await this.impact(id));
  }

  /**
   * Suppression définitive en cascade : journées, positions, formulaires et missions
   * individuelles de l'utilisateur. Ses groupes perdent leur chef.
   */
  async remove(current: AuthUser, id: string, force?: boolean) {
    const m = this.db.manager;
    if (id === current.id) {
      throw forbidden('Vous ne pouvez pas supprimer votre propre compte');
    }
    const user = await m.findOneBy(User, { id });
    if (!user) throw notFound('Utilisateur');
    if (user.role === Role.Admin && user.isActive) {
      const admins = await m.countBy(User, {
        role: Role.Admin,
        isActive: true,
      });
      if (admins <= 1) {
        throw forbidden('La structure doit garder au moins un administrateur');
      }
    }
    assertDeletable(await this.impact(id), force);
    await this.revocation.revoke(id);
    await m.delete(User, { id });
  }

  /**
   * Les agents et chefs d'équipe se connectent à l'app mobile avec leur numéro :
   * il est obligatoire, normalisé et unique.
   */
  private async checkPhone(
    role: Role,
    raw: string | null | undefined,
    userId?: string,
  ): Promise<string | null> {
    const phone = raw ? requirePhone(raw) : null;
    if (!phone && role !== Role.Admin) {
      throw badRequest(
        'PHONE_REQUIRED',
        "Le numéro de téléphone est obligatoire : il sert à se connecter à l'app mobile",
      );
    }
    if (phone) await this.auth.assertPhoneFree(phone, userId);
    return phone;
  }

  private async assertGroup(role: Role, groupId: string | null | undefined) {
    if (!groupId) return;
    if (role !== Role.Agent) {
      throw badRequest(
        'GROUP_ONLY_FOR_AGENTS',
        'Seuls les agents appartiennent à un groupe',
      );
    }
    if (!(await this.db.manager.existsBy(Group, { id: groupId })))
      throw notFound('Groupe');
  }
}
