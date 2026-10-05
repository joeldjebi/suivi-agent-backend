import { Injectable } from '@nestjs/common';
import { Feature, FieldType, type MissionPay, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { badRequest, forbidden, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import {
  assertDeletable,
  countSql,
  describeImpact,
  type Impact,
} from '../common/deletion';
import { Mission, MissionType } from '../entities';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { normalizePay } from './mission-pay';
import {
  CreateMissionTypeDto,
  MissionFieldDto,
  UpdateMissionTypeDto,
} from './missions.dto';

@Injectable()
export class MissionTypesService {
  constructor(
    private readonly db: DbService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /**
   * Type tel que vu par l'utilisateur : l'administrateur voit ses conditions de
   * rémunération ; les autres savent seulement qu'il en a.
   */
  view(user: AuthUser, type: MissionType) {
    const { pay, ...rest } = type;
    return {
      ...rest,
      hasPay: pay !== null,
      ...(user.role === Role.Admin ? { pay } : {}),
    };
  }

  /** Rémunération du type (administrateur, formule Entreprise) ; null : grille de l'agent. */
  async setPay(user: AuthUser, id: string, pay: MissionPay | null) {
    if (user.role !== Role.Admin)
      throw forbidden(
        'Seul un administrateur fixe la rémunération d’un type de mission',
      );
    await this.subscriptions.assertFeature(this.db.tenantId, Feature.Payroll);
    await this.get(id);
    await this.db.manager.update(
      MissionType,
      { id },
      { pay: pay ? normalizePay(pay) : null },
    );
    return this.view(user, await this.get(id));
  }

  list(includeInactive = false): Promise<MissionType[]> {
    return this.db.manager.find(MissionType, {
      where: includeInactive ? {} : { isActive: true },
      order: { name: 'ASC' },
    });
  }

  async get(id: string): Promise<MissionType> {
    const type = await this.db.manager.findOneBy(MissionType, { id });
    if (!type) throw notFound('Type de mission');
    return type;
  }

  create(dto: CreateMissionTypeDto): Promise<MissionType> {
    assertFields(dto.fields);
    return this.db.manager.save(MissionType, {
      tenantId: this.db.tenantId,
      name: dto.name,
      description: dto.description ?? null,
      fields: dto.fields,
      isActive: true,
    });
  }

  async update(id: string, dto: UpdateMissionTypeDto): Promise<MissionType> {
    await this.get(id);
    if (dto.fields) assertFields(dto.fields);
    await this.db.manager.update(
      MissionType,
      { id },
      { ...dto, fields: dto.fields },
    );
    return this.get(id);
  }

  /** Ce qu'une suppression définitive emporterait. */
  async impact(id: string): Promise<Impact> {
    await this.get(id);
    const [row] = await this.db.manager.query<Impact[]>(
      `SELECT ${countSql('missions', 'type_id')} AS missions`,
      [id],
    );
    return row;
  }

  async describeImpact(id: string) {
    return describeImpact(await this.impact(id));
  }

  /** Suppression définitive : les missions de ce type et leurs formulaires sont supprimés. */
  async remove(id: string, force?: boolean) {
    assertDeletable(await this.impact(id), force);
    await this.db.manager.delete(Mission, { typeId: id });
    await this.db.manager.delete(MissionType, { id });
  }
}

function assertFields(fields: MissionFieldDto[]) {
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key))
      throw badRequest('DUPLICATE_FIELD', `Champ en double : ${field.key}`);
    keys.add(field.key);
    if (field.type === FieldType.Select && !field.options?.length) {
      throw badRequest(
        'MISSING_OPTIONS',
        `Le champ ${field.key} doit proposer des options`,
      );
    }
  }
}
