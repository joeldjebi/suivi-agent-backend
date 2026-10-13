import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Feature,
  FieldType,
  type MissionEarnings,
  type MissionPay,
  MissionStatus,
  ProgressMethod,
  Role,
  SubmissionStatus,
  VisitMode,
} from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import {
  BusinessException,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../common/business.exception';
import { DbService } from '../common/db.service';
import { photoIdsOf, validateData } from '../common/form-fields';
import {
  assertDeletable,
  countSql,
  describeImpact,
  type Impact,
} from '../common/deletion';
import { NotificationsService } from '../common/notifications.service';
import { localDate } from '../common/time.util';
import {
  Group,
  Mission,
  MissionSubmission,
  MissionType,
  PayGrid,
  User,
  WorkDay,
} from '../entities';
import { PayrollCalculator, type Payee } from '../payroll/payroll.calculator';
import {
  distanceM,
  OutletsService,
  type OutletView,
} from '../outlets/outlets.service';
import { PhotosService } from '../photos/photos.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { normalizePay } from './mission-pay';
import { MissionTypesService } from './mission-types.service';
import {
  CreateMissionDto,
  CreateSubmissionDto,
  ListMissionsQuery,
  MissionOutletsQuery,
  ListSubmissionsQuery,
  UpdateMissionDto,
} from './missions.dto';

export interface Contribution {
  agentId: string;
  firstName: string;
  lastName: string;
  value: number;
}

/** Mission présentée au choix de la zone. */
export interface ZoneMission {
  id: string;
  title: string;
  description: string | null;
  typeName: string;
  /** Champs du formulaire à remplir (libellés) */
  fields: string[];
  progressMethod: ProgressMethod;
  targetValue: number;
  dueDate: Date | null;
  status: MissionStatus;
  /** Pour lui, pour son groupe, ou ouverte à tous les agents de la zone */
  assignment: 'agent' | 'group' | 'open';
  progress: Progress;
  myForms: number;
  myEarnings: MissionEarnings | null;
}

export interface Progress {
  current: number;
  target: number;
  percent: number;
}

@Injectable()
export class MissionsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly types: MissionTypesService,
    private readonly notifications: NotificationsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly photos: PhotosService,
    private readonly outlets: OutletsService,
  ) {}

  async list(user: AuthUser, query: ListMissionsQuery) {
    const qb = this.db.manager.createQueryBuilder(Mission, 'm');
    if (query.sort === 'due')
      qb.orderBy('m.dueDate', 'ASC', 'NULLS LAST').addOrderBy(
        'm.createdAt',
        'DESC',
      );
    else if (query.sort === 'title') qb.orderBy('m.title', 'ASC');
    else qb.orderBy('m.createdAt', 'DESC');
    if (user.role === Role.Agent) {
      const agent = await this.access.getAgent(user.id);
      const zones = await this.access.accessibleZoneIds(
        agent,
        await this.access.settings(),
      );
      // Assignées à lui, à son groupe, ou ouvertes dans une zone qu'il peut choisir.
      qb.andWhere(
        `(m.assigneeAgentId = :me OR m.assigneeGroupId = :group
          OR (m.assigneeAgentId IS NULL AND m.assigneeGroupId IS NULL
              AND EXISTS (SELECT 1 FROM mission_zones mz WHERE mz.mission_id = m.id AND mz.zone_id = ANY(:zones))))`,
        { me: user.id, group: agent.groupId, zones },
      );
    } else if (
      user.role === Role.TeamLead &&
      !(await this.access.supervisesAll(user))
    ) {
      const groupIds = await this.access.leaderGroupIds(user.id);
      const agentIds = (await this.access.agentScope(user)) ?? [];
      const zones = await this.leadZoneIds(user);
      qb.andWhere(
        `(m.assigneeGroupId = ANY(:groupIds) OR m.assigneeAgentId = ANY(:agentIds)
          OR (m.assigneeAgentId IS NULL AND m.assigneeGroupId IS NULL
              AND (m.createdById = :lead
                   OR EXISTS (SELECT 1 FROM mission_zones mz WHERE mz.mission_id = m.id AND mz.zone_id = ANY(:zones)))))`,
        { groupIds, agentIds, zones, lead: user.id },
      );
    }
    if (query.zoneId)
      qb.andWhere(
        'EXISTS (SELECT 1 FROM mission_zones mz WHERE mz.mission_id = m.id AND mz.zone_id = :zoneId)',
        { zoneId: query.zoneId },
      );
    // Les agents ne voient jamais les missions désactivées.
    if (user.role === Role.Agent || !query.includeInactive)
      qb.andWhere('m.isActive');
    if (query.status)
      qb.andWhere('m.status = :status', { status: query.status });
    if (query.agentId)
      qb.andWhere('m.assigneeAgentId = :agentId', { agentId: query.agentId });
    if (query.groupId)
      qb.andWhere('m.assigneeGroupId = :groupId', { groupId: query.groupId });
    if (query.typeId)
      qb.andWhere('m.typeId = :typeId', { typeId: query.typeId });
    if (query.search?.trim())
      qb.andWhere('m.title ILIKE :search', {
        search: `%${query.search.trim()}%`,
      });
    const [missions, total] = await qb
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    // Requêtes séquentielles : elles partagent la connexion de la transaction.
    // Agent : nombre de formulaires qu'il a envoyés sur chaque mission (« mes participations »).
    const myForms = new Map<string, number>();
    if (user.role === Role.Agent && missions.length) {
      const rows = await this.db.manager.query<{ id: string; n: number }[]>(
        `SELECT mission_id AS id, count(*)::int AS n FROM mission_submissions
         WHERE agent_id = $1 AND mission_id = ANY($2) GROUP BY mission_id`,
        [user.id, missions.map((x) => x.id)],
      );
      for (const r of rows) myForms.set(r.id, r.n);
    }
    const zones = await this.zonesOf(missions.map((x) => x.id));
    const types = new Map<string, MissionType>();
    const items = [];
    for (const mission of missions) {
      // Agent : ce que la mission lui rapporte, visible dès la liste.
      let myEarnings: MissionEarnings | null | undefined;
      if (user.role === Role.Agent) {
        if (!types.has(mission.typeId))
          types.set(mission.typeId, await this.types.get(mission.typeId));
        myEarnings = await this.earnings(
          user,
          mission,
          types.get(mission.typeId)!,
        );
      }
      items.push({
        ...this.view(user, mission),
        zones: zones.get(mission.id) ?? [],
        progress: await this.progress(mission),
        ...(user.role === Role.Agent
          ? { myForms: myForms.get(mission.id) ?? 0, myEarnings }
          : {}),
      });
    }
    return { items, total, page: query.page, limit: query.limit };
  }

  /**
   * Détail avec la progression et, pour un groupe, la contribution de chaque agent (RG-38).
   * Un agent ne voit pas le détail de ses collègues : seulement sa propre contribution.
   */
  async get(user: AuthUser, id: string) {
    const mission = await this.findVisible(user, id);
    const type = await this.types.get(mission.typeId);
    const progress = await this.progress(mission);
    const contributions = await this.contributions(mission);
    const zones = (await this.zonesOf([mission.id])).get(mission.id) ?? [];
    if (user.role === Role.Agent) {
      const mine = contributions.find((c) => c.agentId === user.id);
      return {
        ...this.view(user, mission),
        zones,
        myEarnings: await this.earnings(user, mission, type),
        type: this.types.view(user, type),
        progress,
        contributions: [],
        myContribution:
          mission.assigneeGroupId &&
          mission.progressMethod !== ProgressMethod.Manual
            ? (mine?.value ?? 0)
            : null,
      };
    }
    return {
      ...this.view(user, mission),
      zones,
      type: this.types.view(user, type),
      progress,
      contributions,
    };
  }

  /**
   * Choix de la zone : pour chaque zone, les missions en cours qui concernent l'agent
   * (assignées à lui, à son groupe, ou ouvertes), avec consignes, objectif, progression et
   * ce qu'elles lui rapportent.
   */
  async forZones(user: AuthUser, zoneIds: string[]) {
    const out = new Map<string, ZoneMission[]>();
    if (!zoneIds.length) return out;
    const agent = await this.access.getAgent(user.id);
    const missions = await this.db.manager
      .createQueryBuilder(Mission, 'm')
      .where('m.isActive')
      .andWhere("m.status NOT IN ('achieved', 'failed')")
      .andWhere('(m.dueDate IS NULL OR m.dueDate > now())')
      .andWhere(
        'EXISTS (SELECT 1 FROM mission_zones mz WHERE mz.mission_id = m.id AND mz.zone_id = ANY(:zones))',
        { zones: zoneIds },
      )
      .andWhere(
        `(m.assigneeAgentId = :me OR m.assigneeGroupId = :group
          OR (m.assigneeAgentId IS NULL AND m.assigneeGroupId IS NULL))`,
        { me: user.id, group: agent.groupId },
      )
      .orderBy('m.dueDate', 'ASC', 'NULLS LAST')
      .getMany();
    const zones = await this.zonesOf(missions.map((x) => x.id));
    const myForms = new Map<string, number>();
    if (missions.length) {
      const rows = await this.db.manager.query<{ id: string; n: number }[]>(
        `SELECT mission_id AS id, count(*)::int AS n FROM mission_submissions
         WHERE agent_id = $1 AND mission_id = ANY($2) GROUP BY mission_id`,
        [user.id, missions.map((x) => x.id)],
      );
      for (const r of rows) myForms.set(r.id, r.n);
    }
    const types = new Map<string, MissionType>();
    for (const mission of missions) {
      if (!types.has(mission.typeId))
        types.set(mission.typeId, await this.types.get(mission.typeId));
      const type = types.get(mission.typeId)!;
      const summary: ZoneMission = {
        id: mission.id,
        title: mission.title,
        description: mission.description,
        typeName: type.name,
        fields: type.fields.map((f) => f.label),
        progressMethod: mission.progressMethod,
        targetValue: mission.targetValue,
        dueDate: mission.dueDate,
        status: mission.status,
        assignment: mission.assigneeAgentId
          ? 'agent'
          : mission.assigneeGroupId
            ? 'group'
            : 'open',
        progress: await this.progress(mission),
        myForms: myForms.get(mission.id) ?? 0,
        myEarnings: await this.earnings(user, mission, type),
      };
      for (const z of zones.get(mission.id) ?? [])
        if (zoneIds.includes(z.id))
          out.set(z.id, [...(out.get(z.id) ?? []), summary]);
    }
    return out;
  }

  /**
   * Rémunération visible : l'administrateur voit les conditions propres de la mission ;
   * les autres savent seulement qu'elle en a.
   */
  private view(user: AuthUser, mission: Mission) {
    const { pay, ...rest } = mission;
    return {
      ...rest,
      hasOwnPay: pay !== null,
      ...(user.role === Role.Admin ? { pay } : {}),
    };
  }

  /** Ce que la mission rapporte à l'agent : ses conditions propres, ou la grille de l'agent. */
  private async earnings(
    user: AuthUser,
    mission: Mission,
    type: MissionType,
  ): Promise<MissionEarnings | null> {
    const { features } = await this.subscriptions.summary(this.db.tenantId);
    if (!features.includes(Feature.Payroll)) return null;
    // La mission, sinon son type, sinon la grille de l'agent.
    const own = mission.pay ?? type.pay;
    if (own)
      return {
        source: mission.pay ? 'mission' : 'type',
        perForm: own.perForm ?? null,
        commissionPercent:
          mission.progressMethod === ProgressMethod.FieldSum
            ? (own.commissionPercent ?? null)
            : null,
        objectiveBonus: own.objectiveBonus ?? [],
      };
    const agent = await this.access.getAgent(user.id);
    const grid = PayrollCalculator.gridFor(
      { id: agent.id, role: 'agent', groupId: agent.groupId } as Payee,
      await this.db.manager.find(PayGrid, { order: { name: 'ASC' } }),
    );
    if (!grid) return null;
    const c = grid.components;
    return {
      source: 'grid',
      perForm: c.perForm
        ? (c.perForm.byType?.[mission.typeId] ?? c.perForm.amount ?? null)
        : null,
      commissionPercent:
        mission.progressMethod === ProgressMethod.FieldSum
          ? (c.commission?.percent ?? null)
          : null,
      objectiveBonus: c.objectiveBonus ?? [],
    };
  }

  /** Rémunération propre : administrateur, formule Entreprise. */
  private async assertCanSetPay(user: AuthUser) {
    if (user.role !== Role.Admin)
      throw forbidden(
        'Seul un administrateur fixe la rémunération propre d’une mission',
      );
    await this.subscriptions.assertFeature(this.db.tenantId, Feature.Payroll);
  }

  /** Définit (ou retire, avec null) la rémunération propre de la mission. */
  async setPay(user: AuthUser, id: string, pay: MissionPay | null) {
    await this.assertCanSetPay(user);
    await this.findManageable(user, id);
    await this.db.manager.update(
      Mission,
      { id },
      { pay: pay ? normalizePay(pay) : null },
    );
    return this.get(user, id);
  }

  async create(user: AuthUser, dto: CreateMissionDto) {
    const m = this.db.manager;
    if (dto.assigneeAgentId && dto.assigneeGroupId) {
      throw badRequest(
        'INVALID_ASSIGNEE',
        'Assignez la mission à un agent, à un groupe, ou à personne',
      );
    }
    const type = await this.types.get(dto.typeId);
    if (!type.isActive)
      throw badRequest('TYPE_INACTIVE', 'Ce type de mission est désactivé');

    if (dto.assigneeAgentId)
      await this.access.assertCanManageAgent(user, dto.assigneeAgentId);
    if (dto.assigneeGroupId) {
      const group = await m.findOneBy(Group, { id: dto.assigneeGroupId });
      if (!group) throw notFound('Groupe');
      if (user.role === Role.TeamLead && group.leaderId !== user.id)
        throw forbidden();
    }

    if (dto.progressMethod === ProgressMethod.FieldSum) {
      const field = type.fields.find((f) => f.key === dto.sumFieldKey);
      if (!field || field.type !== FieldType.Number) {
        throw badRequest(
          'INVALID_SUM_FIELD',
          'sumFieldKey doit désigner un champ numérique du type',
        );
      }
    }
    await this.assertZones(user, dto.zoneIds, {
      agentId: dto.assigneeAgentId,
      groupId: dto.assigneeGroupId,
    });
    if (dto.dueDate) await this.assertNotPast(new Date(dto.dueDate));
    if (dto.pay) await this.assertCanSetPay(user);
    const visits = dto.progressMethod === ProgressMethod.Outlets;
    if (visits) {
      await this.subscriptions.assertFeature(
        this.db.tenantId,
        Feature.PointsOfSale,
      );
      if (!dto.visitMode)
        throw badRequest(
          'VISIT_MODE_REQUIRED',
          'Choisissez une liste de points de vente ou un objectif libre',
        );
      if (dto.visitMode === VisitMode.List) {
        if (!dto.outletIds?.length)
          throw badRequest(
            'OUTLETS_REQUIRED',
            'Choisissez au moins un point de vente à visiter',
          );
        await this.assertOutlets(user, dto.outletIds);
        // Liste précise : l'objectif est de tous les visiter.
        dto.targetValue = dto.outletIds.length;
      }
    }
    if (dto.progressMethod !== ProgressMethod.Manual && !dto.targetValue) {
      throw badRequest(
        'TARGET_REQUIRED',
        'Un objectif chiffré est obligatoire (RG-14)',
      );
    }

    const saved = await m.save(Mission, {
      tenantId: this.db.tenantId,
      typeId: dto.typeId,
      title: dto.title,
      description: dto.description ?? null,
      assigneeAgentId: dto.assigneeAgentId ?? null,
      assigneeGroupId: dto.assigneeGroupId ?? null,
      progressMethod: dto.progressMethod,
      targetValue:
        dto.progressMethod === ProgressMethod.Manual ? 1 : dto.targetValue!,
      sumFieldKey:
        dto.progressMethod === ProgressMethod.FieldSum
          ? dto.sumFieldKey!
          : null,
      visitMode: visits ? dto.visitMode! : null,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      status: MissionStatus.Todo,
      createdById: user.id,
      pay: dto.pay ? normalizePay(dto.pay) : null,
    });
    await this.setZones(saved.id, dto.zoneIds);
    if (visits && dto.visitMode === VisitMode.List)
      await this.setOutlets(saved.id, dto.outletIds!);
    await this.notifications.notify(await this.assigneeIds(saved), {
      type: 'mission.assigned',
      title: 'Nouvelle mission',
      body: saved.title,
      data: { missionId: saved.id },
    });
    return this.get(user, saved.id);
  }

  async update(user: AuthUser, id: string, dto: UpdateMissionDto) {
    const mission = await this.findManageable(user, id);
    const { zoneIds, outletIds, ...fields } = dto;
    if (outletIds) {
      if (mission.visitMode !== VisitMode.List)
        throw badRequest(
          'NOT_A_LIST',
          'Cette mission n’a pas de liste de points de vente',
        );
      await this.assertOutlets(user, outletIds);
      await this.setOutlets(id, outletIds);
      fields.targetValue = outletIds.length;
    } else if (mission.visitMode === VisitMode.List) {
      // L'objectif d'une liste est son nombre de points de vente.
      delete fields.targetValue;
    }
    if (zoneIds) {
      await this.assertZones(user, zoneIds, {
        agentId: mission.assigneeAgentId ?? undefined,
        groupId: mission.assigneeGroupId ?? undefined,
      });
      await this.setZones(id, zoneIds);
    }
    dto = fields;
    if (mission.progressMethod === ProgressMethod.Manual)
      delete dto.targetValue;
    // Une échéance déjà passée peut être gardée telle quelle, pas déplacée dans le passé.
    if (
      dto.dueDate &&
      new Date(dto.dueDate).getTime() !== mission.dueDate?.getTime()
    )
      await this.assertNotPast(new Date(dto.dueDate));
    await this.db.manager.update(
      Mission,
      { id },
      {
        ...dto,
        ...(dto.dueDate !== undefined
          ? { dueDate: dto.dueDate ? new Date(dto.dueDate) : null }
          : {}),
      },
    );
    await this.refreshStatus(id);
    return this.get(user, id);
  }

  /** Échéance au plus tôt aujourd'hui (date de la structure). */
  private async assertNotPast(due: Date) {
    const { timezone } = await this.access.settings();
    if (localDate(due, timezone) < localDate(new Date(), timezone))
      throw badRequest(
        'DUE_DATE_PAST',
        'L’échéance ne peut pas être une date passée',
      );
  }

  /** Ce qu'une suppression définitive emporterait. */
  async impact(user: AuthUser, id: string): Promise<Impact> {
    await this.findManageable(user, id);
    const [row] = await this.db.manager.query<Impact[]>(
      `SELECT ${countSql('mission_submissions', 'mission_id')} AS submissions`,
      [id],
    );
    return row;
  }

  async describeImpact(user: AuthUser, id: string) {
    return describeImpact(await this.impact(user, id));
  }

  /** Suppression définitive : les formulaires reçus sont supprimés avec la mission. */
  async remove(user: AuthUser, id: string, force?: boolean) {
    assertDeletable(await this.impact(user, id), force);
    await this.db.manager.delete(Mission, { id });
  }

  /** Validation manuelle du résultat par le chef d'équipe (RG-36). */
  async setManualResult(user: AuthUser, id: string, achieved: boolean) {
    const mission = await this.findManageable(user, id);
    if (mission.progressMethod !== ProgressMethod.Manual) {
      throw badRequest(
        'NOT_MANUAL',
        'Cette mission est calculée automatiquement',
      );
    }
    await this.db.manager.update(
      Mission,
      { id },
      {
        status: achieved ? MissionStatus.Achieved : MissionStatus.Failed,
      },
    );
    return this.get(user, id);
  }

  /** Formulaire saisi par l'agent ; idempotent grâce à clientId (synchronisation hors ligne). */
  async submit(user: AuthUser, missionId: string, dto: CreateSubmissionDto) {
    const m = this.db.manager;
    const existing = await m.findOneBy(MissionSubmission, {
      agentId: user.id,
      clientId: dto.clientId,
    });
    if (existing) return existing;

    const mission = await this.findVisible(user, missionId);
    const submittedAt = new Date(dto.submittedAt);
    if (mission.dueDate && submittedAt > mission.dueDate) {
      throw conflict('MISSION_CLOSED', "L'échéance de la mission est dépassée");
    }
    if (mission.status === MissionStatus.Failed || !mission.isActive) {
      throw conflict('MISSION_CLOSED', 'Cette mission est clôturée');
    }
    const type = await this.types.get(mission.typeId);
    const data = validateData(type.fields, dto.data);
    const photoIds = photoIdsOf(type.fields, data);
    await this.photos.assertUsable(user.id, photoIds);

    const day = await m
      .createQueryBuilder(WorkDay, 'd')
      .where('d.agentId = :agentId', { agentId: user.id })
      .andWhere(
        'd.startedAt <= :at AND (d.endedAt IS NULL OR d.endedAt >= :at)',
        { at: submittedAt },
      )
      .getOne();
    // Pendant une journée, dans une zone de la mission (réglable par la structure).
    const settings = await this.access.settings();
    const zones = (await this.zonesOf([missionId])).get(missionId) ?? [];
    const inMissionZone = !!day && zones.some((z) => z.id === day.zoneId);
    if (settings.submissionRequiresDay) {
      if (!day)
        throw conflict(
          'DAY_REQUIRED',
          'Démarrez votre journée pour envoyer un formulaire',
        );
      if (!inMissionZone)
        throw conflict(
          'WRONG_ZONE',
          `Cette mission se fait à : ${zones.map((z) => z.name).join(', ')}`,
        );
    }
    // Position saisie hors du périmètre de la zone (marge de tolérance des sorties de zone).
    let outOfZone = !!day && !inMissionZone;
    if (!outOfZone && day && dto.lat != null && dto.lng != null) {
      const [row] = await m.query<{ inside: boolean }[]>(
        `SELECT ST_DWithin(area::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4) AS inside
         FROM zones WHERE id = $1`,
        [day.zoneId, dto.lng, dto.lat, settings.zoneExitToleranceMeters],
      );
      outOfZone = row ? !row.inside : false;
    }

    const visit =
      mission.progressMethod === ProgressMethod.Outlets
        ? await this.checkVisit(user, mission, dto, settings.visitRadiusMeters)
        : null;

    const saved = await m.save(MissionSubmission, {
      tenantId: this.db.tenantId,
      missionId,
      outletId: visit?.outlet.id ?? null,
      distanceM: visit?.distance ?? null,
      agentId: user.id,
      dayId: day?.id ?? null,
      zoneId: day?.zoneId ?? null,
      outOfZone,
      clientId: dto.clientId,
      data,
      lat: dto.lat ?? null,
      lng: dto.lng ?? null,
      submittedAt,
      status: SubmissionStatus.Accepted,
    });
    await this.photos.attach(saved.id, photoIds);
    if (visit) {
      if (visit.outlet.lat == null && dto.lat != null && dto.lng != null)
        await this.outlets.locateFromVisit(
          visit.outlet.id,
          dto.lat,
          dto.lng,
          dto.accuracy ?? null,
          user.id,
        );
      await this.outlets.statusFromVisit(
        user,
        visit.outlet,
        dto.outletStatus,
        dto.outletComment,
      );
    }
    await this.refreshStatus(missionId);
    return saved;
  }

  async listSubmissions(
    user: AuthUser,
    missionId: string,
    query: ListSubmissionsQuery = {},
  ) {
    await this.findVisible(user, missionId);
    const qb = this.db.manager
      .createQueryBuilder(MissionSubmission, 's')
      .innerJoinAndMapOne('s.agent', User, 'a', 'a.id = s.agentId')
      .where('s.missionId = :missionId', { missionId })
      .orderBy('s.submittedAt', 'DESC');
    if (user.role === Role.Agent)
      qb.andWhere('s.agentId = :me', { me: user.id });
    else if (query.agentId)
      qb.andWhere('s.agentId = :agentId', { agentId: query.agentId });
    if (query.status)
      qb.andWhere('s.status = :status', { status: query.status });
    if (query.from) qb.andWhere('s.submittedAt >= :from', { from: query.from });
    if (query.to) qb.andWhere('s.submittedAt < :to', { to: query.to });
    const items = await qb.getMany();
    // Photos : position et heure de prise, pour l'affichage.
    const mission = await this.db.manager.findOneByOrFail(Mission, {
      id: missionId,
    });
    const fields = (await this.types.get(mission.typeId)).fields;
    const meta = await this.photos.meta(
      items.flatMap((s) => photoIdsOf(fields, s.data)),
    );
    // Missions de visites : le nom du point de vente visité.
    const outletIds = [
      ...new Set(items.map((s) => s.outletId).filter((id) => id !== null)),
    ];
    const outlets = new Map(
      outletIds.length
        ? (
            await this.db.manager.query<{ id: string; name: string }[]>(
              `SELECT id, name FROM outlets WHERE id = ANY($1::uuid[])`,
              [outletIds],
            )
          ).map((o) => [o.id, o.name] as const)
        : [],
    );
    return items.map((s) => {
      const ids = photoIdsOf(fields, s.data);
      const outletName = s.outletId ? (outlets.get(s.outletId) ?? null) : null;
      return Object.assign(s, {
        ...(s.outletId ? { outletName } : {}),
        ...(ids.length
          ? {
              photos: Object.fromEntries(
                ids.filter((id) => meta[id]).map((id) => [id, meta[id]]),
              ),
            }
          : {}),
      });
    });
  }

  /** Rejet d'un formulaire : il ne compte plus dans la progression (RG-39). */
  async rejectSubmission(user: AuthUser, submissionId: string, reason: string) {
    const m = this.db.manager;
    const submission = await m.findOneBy(MissionSubmission, {
      id: submissionId,
    });
    if (!submission) throw notFound('Formulaire');
    await this.access.assertCanManageAgent(user, submission.agentId);
    await m.update(
      MissionSubmission,
      { id: submissionId },
      {
        status: SubmissionStatus.Rejected,
        rejectedReason: reason,
        rejectedById: user.id,
        rejectedAt: new Date(),
      },
    );
    await this.refreshStatus(submission.missionId);
    await this.notifications.notify([submission.agentId], {
      type: 'submission.rejected',
      title: 'Formulaire rejeté',
      body: reason,
      data: { submissionId, missionId: submission.missionId },
    });
    return m.findOneByOrFail(MissionSubmission, { id: submissionId });
  }

  /** Missions arrivées à échéance sans atteindre leur objectif (RG-37). */
  async failOverdue(now = new Date()): Promise<number> {
    const rows = await this.db.manager.query<unknown[]>(
      `UPDATE missions SET status = 'failed', updated_at = now()
       WHERE due_date < $1 AND is_active AND status IN ('todo', 'in_progress') RETURNING 1`,
      [now],
    );
    return rows.length;
  }

  async progress(mission: Mission): Promise<Progress> {
    let current: number;
    if (mission.progressMethod === ProgressMethod.Manual) {
      current = mission.status === MissionStatus.Achieved ? 1 : 0;
    } else if (mission.progressMethod === ProgressMethod.Outlets) {
      // Points de vente différents visités (de la liste, pour une liste précise).
      const [row] = await this.db.manager.query<{ value: string }[]>(
        `SELECT count(DISTINCT s.outlet_id) AS value FROM mission_submissions s
         WHERE s.mission_id = $1 AND s.status = 'accepted' AND s.outlet_id IS NOT NULL
           AND (NOT $2 OR EXISTS (SELECT 1 FROM mission_outlets mo
                                  WHERE mo.mission_id = s.mission_id AND mo.outlet_id = s.outlet_id))`,
        [mission.id, mission.visitMode === VisitMode.List],
      );
      current = Number(row.value);
    } else {
      const [row] = await this.db.manager.query<{ value: string }[]>(
        mission.progressMethod === ProgressMethod.Count
          ? `SELECT count(*) AS value FROM mission_submissions WHERE mission_id = $1 AND status = 'accepted'`
          : `SELECT coalesce(sum((data ->> $2)::numeric), 0) AS value FROM mission_submissions
             WHERE mission_id = $1 AND status = 'accepted'`,
        mission.progressMethod === ProgressMethod.Count
          ? [mission.id]
          : [mission.id, mission.sumFieldKey],
      );
      current = Number(row.value);
    }
    const target = mission.targetValue;
    return {
      current,
      target,
      percent: Math.min(100, Math.round((current / target) * 100)),
    };
  }

  private async contributions(mission: Mission): Promise<Contribution[]> {
    if (
      !mission.assigneeGroupId ||
      mission.progressMethod === ProgressMethod.Manual
    )
      return [];
    const valueExpr =
      mission.progressMethod === ProgressMethod.Count
        ? 'count(s.id)'
        : mission.progressMethod === ProgressMethod.Outlets
          ? 'count(DISTINCT s.outlet_id)'
          : `coalesce(sum((s.data ->> $2)::numeric), 0)`;
    return this.db.manager.query<Contribution[]>(
      `SELECT u.id AS "agentId", u.first_name AS "firstName", u.last_name AS "lastName",
              ${valueExpr}::float8 AS value
       FROM mission_submissions s JOIN users u ON u.id = s.agent_id
       WHERE s.mission_id = $1 AND s.status = 'accepted'
       GROUP BY u.id ORDER BY value DESC`,
      mission.progressMethod === ProgressMethod.FieldSum
        ? [mission.id, mission.sumFieldKey]
        : [mission.id],
    );
  }

  /** Recalcule le statut après une saisie, un rejet ou une modification de l'objectif. */
  private async refreshStatus(missionId: string) {
    const m = this.db.manager;
    const mission = await m.findOneByOrFail(Mission, { id: missionId });
    if (mission.progressMethod === ProgressMethod.Manual) return;
    const { current, target } = await this.progress(mission);
    const overdue = !!mission.dueDate && mission.dueDate < new Date();
    const status =
      current >= target
        ? MissionStatus.Achieved
        : overdue
          ? MissionStatus.Failed
          : current > 0
            ? MissionStatus.InProgress
            : MissionStatus.Todo;
    if (status !== mission.status)
      await m.update(Mission, { id: missionId }, { status });
  }

  private async findVisible(user: AuthUser, id: string): Promise<Mission> {
    const mission = await this.db.manager.findOneBy(Mission, { id });
    if (!mission) throw notFound('Mission');
    if (user.role === Role.Admin) return mission;
    if (user.role === Role.Agent) {
      const agent = await this.access.getAgent(user.id);
      const assigned =
        mission.assigneeAgentId === user.id ||
        (!!mission.assigneeGroupId &&
          mission.assigneeGroupId === agent.groupId) ||
        (!mission.assigneeAgentId &&
          !mission.assigneeGroupId &&
          (await this.inZones(
            mission.id,
            await this.access.accessibleZoneIds(
              agent,
              await this.access.settings(),
            ),
          )));
      if (!assigned) throw notFound('Mission');
      // Désactivée après coup : l'agent sait qu'elle est close (et non introuvable).
      if (!mission.isActive)
        throw conflict('MISSION_CLOSED', 'Cette mission est clôturée');
      return mission;
    }
    return this.findManageable(user, id, mission);
  }

  private async findManageable(
    user: AuthUser,
    id: string,
    loaded?: Mission,
  ): Promise<Mission> {
    const mission =
      loaded ?? (await this.db.manager.findOneBy(Mission, { id }));
    if (!mission) throw notFound('Mission');
    if (user.role === Role.Admin) return mission;
    if (user.role !== Role.TeamLead) throw forbidden();
    if (await this.access.supervisesAll(user)) return mission;
    if (mission.assigneeAgentId) {
      await this.access.assertCanManageAgent(user, mission.assigneeAgentId);
    } else if (!mission.assigneeGroupId) {
      // Mission ouverte : celle qu'il a créée, ou dans une zone qu'il encadre.
      if (
        mission.createdById !== user.id &&
        !(await this.inZones(mission.id, await this.leadZoneIds(user)))
      )
        throw forbidden();
    } else if (
      !(await this.access.leaderGroupIds(user.id)).includes(
        mission.assigneeGroupId,
      )
    ) {
      throw forbidden();
    }
    return mission;
  }

  /** Zones actives de chaque mission. */
  private async zonesOf(
    missionIds: string[],
  ): Promise<Map<string, { id: string; name: string }[]>> {
    const out = new Map<string, { id: string; name: string }[]>();
    if (!missionIds.length) return out;
    const rows = await this.db.manager.query<
      { missionId: string; id: string; name: string }[]
    >(
      `SELECT mz.mission_id AS "missionId", z.id, z.name
       FROM mission_zones mz JOIN zones z ON z.id = mz.zone_id AND z.is_active
       WHERE mz.mission_id = ANY($1) ORDER BY z.name`,
      [missionIds],
    );
    for (const r of rows)
      out.set(r.missionId, [
        ...(out.get(r.missionId) ?? []),
        { id: r.id, name: r.name },
      ]);
    return out;
  }

  /**
   * Visite d'un point de vente : celui de la liste (ou des zones de la mission, en mode
   * libre), et l'agent sur place (distance maximale réglée par la structure, la précision du
   * GPS tolérée jusqu'à 25 m). Un point de vente sans position est localisé par la visite.
   */
  private async checkVisit(
    user: AuthUser,
    mission: Mission,
    dto: CreateSubmissionDto,
    radius: number,
  ): Promise<{ outlet: OutletView; distance: number | null }> {
    if (!dto.outletId)
      throw badRequest(
        'OUTLET_REQUIRED',
        'Choisissez le point de vente visité',
      );
    const outlet = await this.outlets.findForVisit(user, dto.outletId);
    if (mission.visitMode === VisitMode.List) {
      const [listed] = await this.db.manager.query<unknown[]>(
        `SELECT 1 FROM mission_outlets WHERE mission_id = $1 AND outlet_id = $2`,
        [mission.id, outlet.id],
      );
      if (!listed)
        throw conflict(
          'OUTLET_NOT_IN_MISSION',
          `« ${outlet.name} » ne fait pas partie des points de vente de cette mission`,
        );
    } else if (outlet.lat != null) {
      const [inside] = await this.db.manager.query<unknown[]>(
        `SELECT 1 FROM mission_zones mz JOIN zones z ON z.id = mz.zone_id AND z.is_active
         JOIN outlets o ON o.id = $2
         WHERE mz.mission_id = $1 AND ST_Covers(z.area, o.location) LIMIT 1`,
        [mission.id, outlet.id],
      );
      if (!inside)
        throw conflict(
          'OUTLET_OUTSIDE_MISSION',
          `« ${outlet.name} » est en dehors des zones de cette mission`,
        );
    }
    const hasPosition = dto.lat != null && dto.lng != null;
    if (radius > 0 && !hasPosition)
      throw badRequest(
        'POSITION_REQUIRED',
        'Position introuvable : activez la localisation pour enregistrer la visite',
      );
    if (!hasPosition || outlet.lat == null) return { outlet, distance: null };
    const distance = Math.round(
      distanceM(dto.lat!, dto.lng!, outlet.lat, outlet.lng!),
    );
    const tolerance = Math.min(dto.accuracy ?? 0, 25);
    if (radius > 0 && distance > radius + tolerance)
      throw new BusinessException(
        HttpStatus.CONFLICT,
        'VISIT_TOO_FAR',
        `Vous êtes à ${distance} m de « ${outlet.name} » : rapprochez-vous (${radius} m au plus)`,
        { distance, radius },
      );
    return { outlet, distance };
  }

  /** Points de vente visibles par l'utilisateur. */
  private async assertOutlets(user: AuthUser, ids: string[]) {
    for (const id of ids) await this.outlets.findForVisit(user, id);
  }

  private async setOutlets(missionId: string, outletIds: string[]) {
    await this.db.manager.query(
      `DELETE FROM mission_outlets WHERE mission_id = $1`,
      [missionId],
    );
    await this.db.manager.query(
      `INSERT INTO mission_outlets (mission_id, outlet_id, tenant_id)
       SELECT $1, unnest($2::uuid[]), $3`,
      [missionId, outletIds, this.db.tenantId],
    );
  }

  /**
   * Points de vente d'une mission de visites, avec leurs visites : la liste précise, ou en
   * mode libre ceux des zones de la mission. Ceux à visiter d'abord (les plus proches si la
   * position est donnée), puis ceux déjà visités.
   */
  async missionOutlets(user: AuthUser, id: string, q: MissionOutletsQuery) {
    const mission = await this.findVisible(user, id);
    if (mission.progressMethod !== ProgressMethod.Outlets)
      throw badRequest(
        'NOT_A_VISIT_MISSION',
        'Cette mission n’est pas une mission de visites',
      );
    const near = q.lat != null && q.lng != null;
    const rows = await this.db.manager.query<
      {
        id: string;
        name: string;
        category: string | null;
        status: string;
        lat: number | null;
        lng: number | null;
        visits: number;
        lastVisitAt: Date | null;
        lastVisitBy: string | null;
        distance: number | null;
      }[]
    >(
      `WITH targets AS (
         SELECT o.* FROM outlets o
         WHERE ($2 AND EXISTS (SELECT 1 FROM mission_outlets mo WHERE mo.mission_id = $1 AND mo.outlet_id = o.id))
            OR (NOT $2 AND o.location IS NOT NULL AND EXISTS (
                  SELECT 1 FROM mission_zones mz JOIN zones z ON z.id = mz.zone_id AND z.is_active
                  WHERE mz.mission_id = $1 AND ST_Covers(z.area, o.location)))
       )
       SELECT t.id, t.name, t.category, t.status, ST_Y(t.location) AS lat, ST_X(t.location) AS lng,
              count(s.id)::int AS visits, max(s.submitted_at) AS "lastVisitAt",
              (SELECT trim(u.first_name || ' ' || u.last_name) FROM mission_submissions s2
                 JOIN users u ON u.id = s2.agent_id
                 WHERE s2.mission_id = $1 AND s2.outlet_id = t.id AND s2.status = 'accepted'
                 ORDER BY s2.submitted_at DESC LIMIT 1) AS "lastVisitBy",
              CASE WHEN $3::float8 IS NULL OR t.location IS NULL THEN NULL
                   ELSE round(ST_Distance(t.location::geography,
                          ST_SetSRID(ST_MakePoint($4::float8, $3::float8), 4326)::geography))::int END AS distance
       FROM targets t
       LEFT JOIN mission_submissions s
         ON s.mission_id = $1 AND s.outlet_id = t.id AND s.status = 'accepted'
       GROUP BY t.id, t.name, t.category, t.status, t.location
       ORDER BY (count(s.id) > 0), ${near ? 'distance NULLS LAST,' : ''} t.name
       LIMIT 1000`,
      [
        mission.id,
        mission.visitMode === VisitMode.List,
        q.lat ?? null,
        q.lng ?? null,
      ],
    );
    return rows.map((r) => ({ ...r, visited: r.visits > 0 }));
  }

  private async setZones(missionId: string, zoneIds: string[]) {
    await this.db.manager.query(
      `DELETE FROM mission_zones WHERE mission_id = $1`,
      [missionId],
    );
    await this.db.manager.query(
      `INSERT INTO mission_zones (mission_id, zone_id, tenant_id)
       SELECT $1, unnest($2::uuid[]), $3`,
      [missionId, zoneIds, this.db.tenantId],
    );
  }

  /** La mission se fait-elle dans l'une de ces zones ? */
  private async inZones(missionId: string, zoneIds: string[]) {
    if (!zoneIds.length) return false;
    const [row] = await this.db.manager.query<unknown[]>(
      `SELECT 1 FROM mission_zones WHERE mission_id = $1 AND zone_id = ANY($2) LIMIT 1`,
      [missionId, zoneIds],
    );
    return !!row;
  }

  /** Zones qu'un chef encadre : celles de ses groupes, plus les zones libres. */
  private async leadZoneIds(user: AuthUser): Promise<string[]> {
    const rows = await this.db.manager.query<{ id: string }[]>(
      `SELECT z.id FROM zones z
       WHERE z.is_active AND (
         EXISTS (SELECT 1 FROM group_zones gz JOIN groups g ON g.id = gz.group_id AND g.is_active
                 WHERE gz.zone_id = z.id AND g.leader_id = $1)
         OR NOT EXISTS (SELECT 1 FROM group_zones gz JOIN groups g ON g.id = gz.group_id AND g.is_active
                        WHERE gz.zone_id = z.id))`,
      [user.id],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Zones d'une mission : actives ; pour un chef, dans son périmètre ; pour un groupe, parmi
   * ses zones ou les zones libres ; pour un agent, parmi celles qu'il peut choisir.
   */
  private async assertZones(
    user: AuthUser,
    zoneIds: string[],
    assignee: { agentId?: string; groupId?: string },
  ) {
    const zones = await this.db.manager.query<
      { id: string; name: string; groupIds: string[] }[]
    >(
      `SELECT z.id, z.name,
              ARRAY(SELECT gz.group_id::text FROM group_zones gz JOIN groups g ON g.id = gz.group_id AND g.is_active
                    WHERE gz.zone_id = z.id) AS "groupIds"
       FROM zones z WHERE z.id = ANY($1) AND z.is_active`,
      [zoneIds],
    );
    if (zones.length !== zoneIds.length)
      throw badRequest('INVALID_ZONES', 'Zone inconnue ou désactivée');
    const refuse = (code: string, message: string) => {
      throw badRequest(code, message);
    };
    if (
      user.role === Role.TeamLead &&
      !(await this.access.supervisesAll(user))
    ) {
      const mine = await this.leadZoneIds(user);
      const outside = zones.find((z) => !mine.includes(z.id));
      if (outside)
        refuse(
          'ZONE_OUTSIDE_SCOPE',
          `« ${outside.name} » n’est pas une zone de vos groupes`,
        );
    }
    if (assignee.groupId) {
      const outside = zones.find(
        (z) => z.groupIds.length && !z.groupIds.includes(assignee.groupId!),
      );
      if (outside)
        refuse(
          'ZONE_OUTSIDE_GROUP',
          `« ${outside.name} » est réservée à un autre groupe`,
        );
    }
    if (assignee.agentId) {
      const agent = await this.access.getAgent(assignee.agentId);
      const open = await this.access.accessibleZoneIds(
        agent,
        await this.access.settings(),
      );
      const outside = zones.find((z) => !open.includes(z.id));
      if (outside)
        refuse(
          'ZONE_NOT_ACCESSIBLE',
          `L’agent ne peut pas choisir la zone « ${outside.name} »`,
        );
    }
  }

  private async assigneeIds(mission: Mission): Promise<string[]> {
    if (mission.assigneeAgentId) return [mission.assigneeAgentId];
    if (!mission.assigneeGroupId) {
      // Mission ouverte : les agents qui peuvent choisir une de ses zones.
      const zones = (await this.zonesOf([mission.id])).get(mission.id) ?? [];
      const settings = await this.access.settings();
      const agents = await this.db.manager.find(User, {
        where: { role: Role.Agent, isActive: true },
      });
      const ids: string[] = [];
      for (const agent of agents) {
        const open = await this.access.accessibleZoneIds(agent, settings);
        if (zones.some((z) => open.includes(z.id))) ids.push(agent.id);
      }
      return ids;
    }
    const agents = await this.db.manager.find(User, {
      select: { id: true },
      where: {
        groupId: mission.assigneeGroupId,
        role: Role.Agent,
        isActive: true,
      },
    });
    return agents.map((a) => a.id);
  }
}
