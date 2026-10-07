import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AlertType, Role } from '@suivi/shared';
import {
  Between,
  FindOptionsWhere,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  Not,
} from 'typeorm';
import { AccessService } from '../common/access.service';
import { AlertsService } from '../common/alerts.service';
import type { AuthUser } from '../common/auth-user';
import { conflict, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { AllowWhenSuspended, CurrentUser, Roles } from '../common/decorators';
import { AgentAlert, User } from '../entities';
import {
  AcknowledgeDto,
  CloseAlertDto,
  ListAlertsQuery,
  RaiseSosDto,
} from './alerts.dto';

@ApiTags('Alertes')
@ApiBearerAuth()
@Roles(Role.Admin, Role.TeamLead)
@Controller('alerts')
export class AlertsController {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly alerts: AlertsService,
  ) {}

  /**
   * Centre d'alertes : signal perdu, immobile, batterie faible, position simulée, hors zone,
   * journée pas démarrée. Le chef voit les agents de son périmètre ; 300 au plus.
   */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() query: ListAlertsQuery) {
    const scope = await this.access.agentScope(user);
    if (scope && !scope.length) return [];
    if (query.agentId && scope && !scope.includes(query.agentId)) return [];
    const status = query.status ?? 'open';
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    const where: FindOptionsWhere<AgentAlert> = {
      ...(query.agentId
        ? { agentId: query.agentId }
        : scope
          ? { agentId: In(scope) }
          : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(status === 'open'
        ? { resolvedAt: IsNull() }
        : status === 'resolved'
          ? { resolvedAt: Not(IsNull()) }
          : {}),
      ...(from && to
        ? { startedAt: Between(from, to) }
        : from
          ? { startedAt: MoreThanOrEqual(from) }
          : to
            ? { startedAt: LessThanOrEqual(to) }
            : {}),
    };
    const alerts = await this.db.manager.find(AgentAlert, {
      where,
      order: { startedAt: 'DESC' },
      take: 300,
    });
    return this.alerts.toInfo(alerts);
  }

  /** « Je m'en occupe » : le responsable prend l'alerte en charge, avec une note facultative. */
  @Post(':id/ack')
  async acknowledge(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcknowledgeDto,
  ) {
    const m = this.db.manager;
    const alert = await m.findOneBy(AgentAlert, { id });
    if (!alert) throw notFound('Alerte');
    await this.access.assertCanManageAgent(user, alert.agentId);
    await m.update(
      AgentAlert,
      { id },
      {
        acknowledgedAt: new Date(),
        acknowledgedById: user.id,
        note: dto.note?.trim() || null,
      },
    );
    const updated = await m.findOneByOrFail(AgentAlert, { id });
    if (updated.type === AlertType.Sos && !updated.resolvedAt)
      await this.alerts.sosAcknowledged(
        updated,
        await m.findOneByOrFail(User, { id: user.id }),
      );
    const [info] = await this.alerts.toInfo([updated]);
    return info;
  }

  /**
   * Clôture d'une alerte sécurité par un responsable (les autres alertes se referment
   * d'elles-mêmes quand la situation se règle).
   */
  @Post(':id/close')
  async close(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseAlertDto,
  ) {
    const m = this.db.manager;
    const alert = await m.findOneBy(AgentAlert, { id });
    if (!alert) throw notFound('Alerte');
    await this.access.assertCanManageAgent(user, alert.agentId);
    if (alert.type !== AlertType.Sos)
      throw conflict(
        'AUTO_RESOLVED',
        'Cette alerte se referme d’elle-même quand la situation se règle',
      );
    if (!alert.resolvedAt)
      await this.alerts.closeSos(
        alert,
        await m.findOneByOrFail(User, { id: user.id }),
        dto.note?.trim() || null,
      );
    const [info] = await this.alerts.toInfo([
      await m.findOneByOrFail(AgentAlert, { id }),
    ]);
    return info;
  }
}

/** Alerte sécurité de l'agent : déclenchée depuis l'app, avec sa position. */
@ApiTags('Alerte sécurité (agent)')
@ApiBearerAuth()
@Roles(Role.Agent)
@AllowWhenSuspended()
@Controller('safety/sos')
export class SafetyController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  current(@CurrentUser() user: AuthUser) {
    return this.alerts.currentSos(user.id);
  }

  /** Demande d'aide : le chef et les administrateurs sont prévenus aussitôt. */
  @Post()
  raise(@CurrentUser() user: AuthUser, @Body() dto: RaiseSosDto) {
    return this.alerts.raiseSos(user.id, {
      ...(dto.lat != null && dto.lng != null
        ? { lat: dto.lat, lng: dto.lng }
        : {}),
      ...(dto.accuracy != null ? { accuracy: dto.accuracy } : {}),
      ...(dto.battery != null ? { battery: dto.battery } : {}),
      ...(dto.message?.trim() ? { message: dto.message.trim() } : {}),
    });
  }

  /** Fausse alerte : annulée par l'agent. */
  @Post('cancel')
  @HttpCode(204)
  cancel(@CurrentUser() user: AuthUser) {
    return this.alerts.cancelSos(user.id);
  }
}
