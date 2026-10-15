import { Injectable } from '@nestjs/common';
import { Role, SubmissionStatus } from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest, conflict, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { photoIdsOf, validateData } from '../common/form-fields';
import { MissionSubmission, MissionType, WorkDay } from '../entities';
import { PhotosService } from '../photos/photos.service';
import { ProductsService } from '../products/products.service';
import type { CreateVisitDto } from './outlets.dto';
import { OutletsService } from './outlets.service';
import { assertPresence } from './visit-rules';

/**
 * Visites libres des points de vente (module Points de vente, sans mission). Elles utilisent
 * le socle commun aux deux modules : mêmes formulaires, mêmes formulaires reçus, mêmes règles
 * (journée, zone, distance) et mêmes relevés par produit que les visites de mission.
 */
@Injectable()
export class VisitsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly outlets: OutletsService,
    private readonly photos: PhotosService,
    private readonly products: ProductsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async typeIds(): Promise<string[]> {
    const [row] = await this.db.manager.query<{ ids: string[] }[]>(
      `SELECT outlet_visit_type_ids AS ids FROM tenant_settings WHERE tenant_id = $1`,
      [this.db.tenantId],
    );
    return row?.ids ?? [];
  }

  /** Formulaires proposés pour les visites libres (actifs), avec les produits de leurs relevés. */
  async forms() {
    const ids = await this.typeIds();
    if (!ids.length) return [];
    const types = await this.db.manager.query<
      {
        id: string;
        name: string;
        description: string | null;
        fields: MissionType['fields'];
      }[]
    >(
      `SELECT id, name, description, fields FROM mission_types
       WHERE id = ANY($1::uuid[]) AND is_active ORDER BY array_position($1::uuid[], id)`,
      [ids],
    );
    return Promise.all(
      types.map(async (t) => ({
        ...t,
        products: await this.products.forFields(t.fields),
      })),
    );
  }

  /** Administrateur : les formulaires proposés pour visiter un point de vente sans mission. */
  async setForms(typeIds: string[]) {
    const unique = [...new Set(typeIds)];
    if (unique.length) {
      const [{ found }] = await this.db.manager.query<{ found: number }[]>(
        `SELECT count(*)::int AS found FROM mission_types WHERE id = ANY($1::uuid[])`,
        [unique],
      );
      if (found !== unique.length) throw notFound('Formulaire');
    }
    await this.db.manager.query(
      `UPDATE tenant_settings SET outlet_visit_type_ids = $2::uuid[] WHERE tenant_id = $1`,
      [this.db.tenantId, unique],
    );
    return this.forms();
  }

  /** Visite libre d'un point de vente par un agent. */
  async visit(user: AuthUser, outletId: string, dto: CreateVisitDto) {
    const m = this.db.manager;
    const existing = await m.findOneBy(MissionSubmission, {
      agentId: user.id,
      clientId: dto.clientId,
    });
    if (existing) return existing;

    const outlet = await this.outlets.findForVisit(user, outletId);
    if (!(await this.typeIds()).includes(dto.typeId))
      throw badRequest(
        'VISIT_FORM_NOT_ALLOWED',
        'Ce formulaire n’est pas proposé pour les visites de points de vente',
      );
    const type = await m.findOneBy(MissionType, { id: dto.typeId });
    if (!type?.isActive) throw notFound('Formulaire');

    const submittedAt = new Date(dto.submittedAt);
    const settings = await this.access.settings();
    // Même règle que les formulaires de mission : pendant une journée, dans sa zone du jour.
    const day = await m
      .createQueryBuilder(WorkDay, 'd')
      .where('d.agentId = :agentId', { agentId: user.id })
      .andWhere(
        'd.startedAt <= :at AND (d.endedAt IS NULL OR d.endedAt >= :at)',
        { at: submittedAt },
      )
      .getOne();
    let inDayZone = false;
    if (day?.zoneId) {
      const [row] = await m.query<{ inside: boolean }[]>(
        `SELECT o.location IS NULL OR ST_Covers(z.area, o.location) AS inside
         FROM zones z, outlets o WHERE z.id = $1 AND o.id = $2`,
        [day.zoneId, outlet.id],
      );
      inDayZone = !!row?.inside;
    }
    if (settings.submissionRequiresDay) {
      if (!day)
        throw conflict(
          'DAY_REQUIRED',
          'Démarrez votre journée pour enregistrer une visite',
        );
      if (!inDayZone)
        throw conflict(
          'WRONG_ZONE',
          `« ${outlet.name} » n’est pas dans votre zone du jour`,
        );
    }
    const distance = assertPresence(outlet, dto, settings.visitRadiusMeters);

    const productsByField = await this.products.forFields(type.fields);
    const data = validateData(
      type.fields,
      dto.data,
      Object.fromEntries(
        Object.entries(productsByField).map(([key, list]) => [
          key,
          new Set(list.map((p) => p.id)),
        ]),
      ),
    );
    const photoIds = photoIdsOf(type.fields, data);
    await this.photos.assertUsable(user.id, photoIds);

    const saved = await m.save(MissionSubmission, {
      tenantId: this.db.tenantId,
      missionId: null,
      typeId: type.id,
      outletId: outlet.id,
      distanceM: distance,
      agentId: user.id,
      dayId: day?.id ?? null,
      zoneId: day?.zoneId ?? null,
      outOfZone: !!day && !inDayZone,
      clientId: dto.clientId,
      data,
      lat: dto.lat ?? null,
      lng: dto.lng ?? null,
      submittedAt,
      status: SubmissionStatus.Accepted,
    });
    await this.photos.attach(saved.id, photoIds);
    await this.products.saveReadings(saved, type.fields);
    if (outlet.lat == null && dto.lat != null && dto.lng != null)
      await this.outlets.locateFromVisit(
        outlet.id,
        dto.lat,
        dto.lng,
        dto.accuracy ?? null,
        user.id,
      );
    await this.outlets.statusFromVisit(
      user,
      outlet,
      dto.outletStatus,
      dto.outletComment,
    );
    return saved;
  }

  /** Rejet d'une visite libre par un responsable : elle ne compte plus (retards, relevés). */
  async reject(user: AuthUser, submissionId: string, reason: string) {
    const m = this.db.manager;
    const s = await m.findOneBy(MissionSubmission, { id: submissionId });
    if (!s || s.missionId !== null) throw notFound('Visite');
    if (user.role !== Role.Admin)
      await this.access.assertCanManageAgent(user, s.agentId);
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
    await this.notifications.notify([s.agentId], {
      type: 'visit.rejected',
      title: 'Visite rejetée',
      body: reason,
      data: { submissionId, outletId: s.outletId },
    });
    return m.findOneByOrFail(MissionSubmission, { id: submissionId });
  }
}
