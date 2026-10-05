import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import { DeleteQuery } from '../common/deletion';
import { MissionTypesService } from './mission-types.service';
import {
  CreateMissionDto,
  CreateMissionTypeDto,
  CreateSubmissionDto,
  ListMissionsQuery,
  ListSubmissionsQuery,
  ManualResultDto,
  MissionPayDto,
  RejectSubmissionDto,
  UpdateMissionDto,
  UpdateMissionTypeDto,
} from './missions.dto';
import { MissionsService } from './missions.service';

@ApiTags('Types de missions')
@ApiBearerAuth()
@RequiresFeature(Feature.Missions)
@Controller('mission-types')
export class MissionTypesController {
  constructor(private readonly types: MissionTypesService) {}

  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ) {
    return (await this.types.list(includeInactive)).map((t) =>
      this.types.view(user, t),
    );
  }

  @Get(':id')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.types.view(user, await this.types.get(id));
  }

  /**
   * Rémunération des missions de ce type (formule Entreprise) : remplace la grille de
   * l'agent, sauf pour une mission qui a ses propres conditions. Administrateur seulement.
   */
  @Roles(Role.Admin)
  @Put(':id/pay')
  setPay(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MissionPayDto,
  ) {
    return this.types.setPay(user, id, dto);
  }

  /** Retour à la grille de l'agent pour ce type. */
  @Roles(Role.Admin)
  @Delete(':id/pay')
  clearPay(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.types.setPay(user, id, null);
  }

  @Roles(Role.Admin)
  @Post()
  create(@Body() dto: CreateMissionTypeDto) {
    return this.types.create(dto);
  }

  @Roles(Role.Admin)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMissionTypeDto,
  ) {
    return this.types.update(id, dto);
  }

  /** Données liées qu'une suppression définitive emporterait. */
  @Roles(Role.Admin)
  @Get(':id/impact')
  impact(@Param('id', ParseUUIDPipe) id: string) {
    return this.types.describeImpact(id);
  }

  /**
   * Suppression définitive. Refusée (409 HAS_DEPENDENCIES) si des missions utilisent ce type,
   * sauf avec `force=true` : elles sont alors supprimées. Préférez la désactivation.
   */
  @Roles(Role.Admin)
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @Query() query: DeleteQuery) {
    return this.types.remove(id, query.force);
  }
}

@ApiTags('Missions')
@ApiBearerAuth()
@RequiresFeature(Feature.Missions)
@Controller()
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  /** Administrateur : toutes. Chef : son périmètre. Agent : ses missions et celles de son groupe. */
  @Get('missions')
  list(@CurrentUser() user: AuthUser, @Query() query: ListMissionsQuery) {
    return this.missions.list(user, query);
  }

  @Get('missions/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.missions.get(user, id);
  }

  @Roles(Role.Admin, Role.TeamLead)
  @Post('missions')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateMissionDto) {
    return this.missions.create(user, dto);
  }

  @Roles(Role.Admin, Role.TeamLead)
  @Patch('missions/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMissionDto,
  ) {
    return this.missions.update(user, id, dto);
  }

  @Roles(Role.Admin, Role.TeamLead)
  @Get('missions/:id/impact')
  impact(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.missions.describeImpact(user, id);
  }

  /**
   * Suppression définitive. Refusée (409 HAS_DEPENDENCIES) si des formulaires ont été reçus,
   * sauf avec `force=true`. Préférez la désactivation (`PATCH { isActive: false }`).
   */
  @Roles(Role.Admin, Role.TeamLead)
  @Delete('missions/:id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeleteQuery,
  ) {
    return this.missions.remove(user, id, query.force);
  }

  /**
   * Rémunération propre de la mission (formule Entreprise) : remplace la grille de l'agent
   * pour les formulaires et l'objectif de cette mission. Administrateur seulement.
   */
  @Roles(Role.Admin)
  @Put('missions/:id/pay')
  setPay(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MissionPayDto,
  ) {
    return this.missions.setPay(user, id, dto);
  }

  /** Retour à la grille de l'agent. */
  @Roles(Role.Admin)
  @Delete('missions/:id/pay')
  clearPay(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.missions.setPay(user, id, null);
  }

  /** Résultat d'une mission en validation manuelle. */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('missions/:id/result')
  @HttpCode(200)
  setResult(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ManualResultDto,
  ) {
    return this.missions.setManualResult(user, id, dto.achieved);
  }

  /** Formulaires d'une mission, du plus récent au plus ancien, filtrables par agent, statut et période. */
  @Get('missions/:id/submissions')
  submissions(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListSubmissionsQuery,
  ) {
    return this.missions.listSubmissions(user, id, query);
  }

  /** Formulaire saisi par l'agent (idempotent sur clientId). */
  @Roles(Role.Agent)
  @Post('missions/:id/submissions')
  submit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSubmissionDto,
  ) {
    return this.missions.submit(user, id, dto);
  }

  @Roles(Role.Admin, Role.TeamLead)
  @Post('submissions/:id/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectSubmissionDto,
  ) {
    return this.missions.rejectSubmission(user, id, dto.reason);
  }
}
