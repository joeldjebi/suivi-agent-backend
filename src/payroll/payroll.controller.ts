import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import {
  AdjustmentDto,
  CreateRunDto,
  DecisionDto,
  MarkPaidDto,
  PayGridDto,
  PaySettingsDto,
} from './payroll.dto';
import { PayrollService } from './payroll.service';

@ApiTags('Rémunération')
@ApiBearerAuth()
@RequiresFeature(Feature.Payroll)
@Controller('pay')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  /** Agent ou chef : estimation de la période en cours et historique. */
  @Roles(Role.Agent, Role.TeamLead)
  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.payroll.mine(user);
  }

  /** Estimation en direct de la période en cours (tous pour l'administrateur, l'équipe pour un chef). */
  @Roles(Role.Admin, Role.TeamLead)
  @Get('current')
  current(@CurrentUser() user: AuthUser) {
    return this.payroll.current(user);
  }

  @Roles(Role.Admin)
  @Get('settings')
  settings() {
    return this.payroll.settings();
  }

  @Roles(Role.Admin)
  @Patch('settings')
  updateSettings(@Body() dto: PaySettingsDto) {
    return this.payroll.updateSettings(dto);
  }

  @Roles(Role.Admin)
  @Get('grids')
  grids() {
    return this.payroll.grids();
  }

  @Roles(Role.Admin)
  @Post('grids')
  createGrid(@Body() dto: PayGridDto) {
    return this.payroll.createGrid(dto);
  }

  @Roles(Role.Admin)
  @Put('grids/:id')
  updateGrid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PayGridDto) {
    return this.payroll.updateGrid(id, dto);
  }

  @Roles(Role.Admin)
  @Delete('grids/:id')
  @HttpCode(204)
  deleteGrid(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.deleteGrid(id);
  }

  @Roles(Role.Admin, Role.TeamLead)
  @Get('runs')
  runs(@CurrentUser() user: AuthUser) {
    return this.payroll.runs(user);
  }

  /** Calcule (ou recalcule) la paie d'une période terminée. */
  @Roles(Role.Admin)
  @Post('runs')
  createRun(@Body() dto: CreateRunDto) {
    return this.payroll.createRun(dto.date);
  }

  @Roles(Role.Admin, Role.TeamLead)
  @Get('runs/:id')
  run(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.run(user, id);
  }

  @Roles(Role.Admin)
  @Post('runs/:id/recalculate')
  @HttpCode(200)
  recalculate(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.recalculate(id);
  }

  /** Verrouille la paie et prévient chaque personne de ses gains. */
  @Roles(Role.Admin)
  @Post('runs/:id/validate')
  @HttpCode(200)
  validate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payroll.validate(user, id);
  }

  /** Paiement fait hors de la plateforme (Mobile Money, banque) : enregistrement. */
  @Roles(Role.Admin)
  @Post('runs/:id/paid')
  @HttpCode(200)
  markPaid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkPaidDto) {
    return this.payroll.markPaid(id, dto);
  }

  /** Administrateur : ajustement appliqué. Chef : proposition pour un agent de son équipe. */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('runs/:id/adjustments')
  addAdjustment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustmentDto,
  ) {
    return this.payroll.addAdjustment(user, id, dto);
  }

  @Roles(Role.Admin)
  @Post('adjustments/:id/decision')
  @HttpCode(200)
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.payroll.decide(user, id, dto.approve);
  }

  @Roles(Role.Admin)
  @Delete('adjustments/:id')
  @HttpCode(204)
  removeAdjustment(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.removeAdjustment(id);
  }
}
