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
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import {
  CreateZoneRequestDto,
  DecideZoneRequestDto,
  ListZoneRequestsQuery,
  ReassignDto,
} from './zone-requests.dto';
import { ZoneRequestsService } from './zone-requests.service';

@ApiTags('Demandes de zone')
@ApiBearerAuth()
@Controller('zone-requests')
export class ZoneRequestsController {
  constructor(private readonly requests: ZoneRequestsService) {}

  /** Administrateur : toutes. Chef d'équipe : ses agents. Agent : les siennes. Filtrer `status=pending` pour la file d'approbation. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListZoneRequestsQuery) {
    return this.requests.list(user, query);
  }

  /** L'agent choisit ou change de zone. */
  @Roles(Role.Agent)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateZoneRequestDto) {
    return this.requests.request(user, dto.zoneId);
  }

  @Roles(Role.Agent)
  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.requests.cancel(user, id);
  }

  @Roles(Role.Admin, Role.TeamLead)
  @Post(':id/decision')
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideZoneRequestDto,
  ) {
    return this.requests.decide(user, id, dto.approve, dto.reason);
  }

  /** Affecte directement un agent à une zone, y compris en cours de journée. */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('reassign')
  reassign(@CurrentUser() user: AuthUser, @Body() dto: ReassignDto) {
    return this.requests.reassign(user, dto);
  }
}
