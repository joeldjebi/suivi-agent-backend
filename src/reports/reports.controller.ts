import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { DailyReportQuery, TeamMessageDto } from './reports.dto';
import { ReportsService } from './reports.service';

@ApiTags('Bilan et messages')
@ApiBearerAuth()
@Roles(Role.Admin, Role.TeamLead)
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Bilan d'une journée : l'équipe du chef, ou toute la structure pour l'administrateur. */
  @Get('reports/daily')
  daily(@CurrentUser() user: AuthUser, @Query() query: DailyReportQuery) {
    return this.reports.daily(user, query);
  }

  /** Message à toute l'équipe, ou à des agents choisis. */
  @Post('team-messages')
  send(@CurrentUser() user: AuthUser, @Body() dto: TeamMessageDto) {
    return this.reports.sendMessage(user, dto);
  }

  @Get('team-messages')
  mine(@CurrentUser() user: AuthUser) {
    return this.reports.myMessages(user);
  }
}
