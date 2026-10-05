import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
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
import { notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { CurrentUser, Roles } from '../common/decorators';
import { AgentAlert } from '../entities';
import { AcknowledgeDto, ListAlertsQuery } from './alerts.dto';

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
    const [info] = await this.alerts.toInfo([
      await m.findOneByOrFail(AgentAlert, { id }),
    ]);
    return info;
  }
}
