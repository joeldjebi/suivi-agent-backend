import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import { StatsQuery } from './stats.dto';
import { StatsService } from './stats.service';

@ApiTags('Statistiques')
@ApiBearerAuth()
@Roles(Role.Admin)
@RequiresFeature(Feature.Stats)
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  /**
   * Vue d'ensemble de la structure sur une période, comparée à la période précédente :
   * activité, formulaires, distance, alertes, demandes de zone, missions, détails par jour,
   * par groupe, par zone et par agent.
   */
  @Get('overview')
  overview(@CurrentUser() user: AuthUser, @Query() query: StatsQuery) {
    return this.stats.overview(user, query);
  }
}
