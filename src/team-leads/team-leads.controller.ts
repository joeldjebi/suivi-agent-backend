import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import { RequiresFeature, Roles } from '../common/decorators';
import { PeriodQuery, TimelineQuery } from './team-leads.dto';
import { TeamLeadsService } from './team-leads.service';

@ApiTags("Chefs d'équipe")
@ApiBearerAuth()
@Roles(Role.Admin)
@RequiresFeature(Feature.TeamLeads)
@Controller('team-leads')
export class TeamLeadsController {
  constructor(private readonly leads: TeamLeadsService) {}

  /** Indicateurs de chaque chef sur la période (30 derniers jours par défaut). */
  @Get()
  list(@Query() query: PeriodQuery) {
    return this.leads.list(query);
  }

  /** Indicateurs d'un chef et les agents de ses groupes. */
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @Query() query: PeriodQuery) {
    return this.leads.get(id, query);
  }

  /** Fil de ses actions : connexions, décisions, rejets, missions… */
  @Get(':id/timeline')
  timeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TimelineQuery,
  ) {
    return this.leads.timeline(id, query);
  }
}
