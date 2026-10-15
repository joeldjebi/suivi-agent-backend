import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import { FormStatsQuery } from './insights.dto';
import { FormStatsService } from './form-stats.service';

/**
 * Statistiques des formulaires de la structure (socle commun : missions et visites de points
 * de vente) : l'administrateur pour toute la structure, le chef pour son équipe, l'agent pour
 * ses propres formulaires.
 */
@ApiTags('Statistiques des formulaires')
@ApiBearerAuth()
@RequiresFeature(Feature.Missions, Feature.PointsOfSale)
@Roles(Role.Admin, Role.TeamLead, Role.Agent)
@Controller('form-stats')
export class FormStatsController {
  constructor(private readonly stats: FormStatsService) {}

  /** Formulaires remplis sur la période, les plus utilisés d'abord. */
  @Get()
  forms(@CurrentUser() user: AuthUser, @Query() q: FormStatsQuery) {
    return this.stats.forms(user, q);
  }

  /** Un formulaire : chaque champ résumé selon son type. */
  @Get(':typeId')
  form(
    @CurrentUser() user: AuthUser,
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @Query() q: FormStatsQuery,
  ) {
    return this.stats.form(user, typeId, q);
  }
}
