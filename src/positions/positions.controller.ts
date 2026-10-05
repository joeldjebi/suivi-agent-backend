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
import { Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { BatchResultDto, LiveQuery, PositionBatchDto } from './positions.dto';
import { PositionsService } from './positions.service';

@ApiTags('Positions et carte en temps réel')
@ApiBearerAuth()
@Controller()
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  /** Envoi d'un lot de positions par l'app mobile (idempotent). */
  @Roles(Role.Agent)
  @Post('positions/batch')
  @HttpCode(200)
  ingest(
    @CurrentUser() user: AuthUser,
    @Body() dto: PositionBatchDto,
  ): Promise<BatchResultDto> {
    return this.positions.ingest(user, dto);
  }

  /** Agents en journée avec leur dernière position, filtrables par groupe, zone et statut. */
  @Roles(Role.Admin, Role.TeamLead)
  @Get('live')
  live(@CurrentUser() user: AuthUser, @Query() query: LiveQuery) {
    return this.positions.liveMap(user, query);
  }

  /** Trajet complet d'une journée. */
  @Get('days/:id/positions')
  track(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.positions.track(user, id);
  }
}
