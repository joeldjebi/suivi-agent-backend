import {
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
import { DayHistoryQuery } from './days.dto';
import { DaysService } from './days.service';

@ApiTags('Journées')
@ApiBearerAuth()
@Controller('days')
export class DaysController {
  constructor(private readonly days: DaysService) {}

  /** Journée en cours de l'agent, avec sa zone approuvée et sa demande en attente. */
  @Roles(Role.Agent)
  @Get('current')
  current(@CurrentUser() user: AuthUser) {
    return this.days.current(user.id);
  }

  @Roles(Role.Agent)
  @Post('start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser) {
    return this.days.start(user);
  }

  @Roles(Role.Agent)
  @Post('pause')
  @HttpCode(200)
  pause(@CurrentUser() user: AuthUser) {
    return this.days.pause(user);
  }

  @Roles(Role.Agent)
  @Post('resume')
  @HttpCode(200)
  resume(@CurrentUser() user: AuthUser) {
    return this.days.resume(user);
  }

  @Roles(Role.Agent)
  @Post('end')
  @HttpCode(200)
  end(@CurrentUser() user: AuthUser) {
    return this.days.end(user);
  }

  /** Historique des journées (administrateur : tous ; chef : son groupe ; agent : les siennes). */
  @Get()
  history(@CurrentUser() user: AuthUser, @Query() query: DayHistoryQuery) {
    return this.days.history(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.days.getForUser(user, id);
  }

  /** Sorties de zone de la journée : heure, durée, distance maximale, chef prévenu ou non. */
  @Get(':id/zone-exits')
  zoneExits(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.days.zoneExitsOf(user, id);
  }
}
