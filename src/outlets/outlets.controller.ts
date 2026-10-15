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
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { Request, Response } from 'express';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import type { ExportFile } from '../exports/exports.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  ChangeOutletStatusDto,
  CreateVisitDto,
  CreateOutletDto,
  ExportOutletsQuery,
  ListOutletsQuery,
  MergeOutletDto,
  OutletFieldsDto,
  OutletRouteQuery,
  OutletsMapQuery,
  UpdateOutletDto,
  VisitFormsDto,
  OutletVisitsQuery,
} from './outlets.dto';
import { OutletsService } from './outlets.service';
import { VisitsService } from './visits.service';
import { RejectSubmissionDto as RejectVisitDto } from '../missions/missions.dto';

const send = (res: Response, file: ExportFile) => {
  res.set({
    'Content-Type': file.mime,
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    'Cache-Control': 'no-store',
  });
  return new StreamableFile(file.data);
};

const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Points de vente : formules qui incluent la fonctionnalité. */
@ApiTags('Points de vente')
@ApiBearerAuth()
@RequiresFeature(Feature.PointsOfSale)
@Roles(Role.Admin, Role.TeamLead, Role.Agent)
@Controller('outlets')
export class OutletsController {
  constructor(
    private readonly outlets: OutletsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly visits: VisitsService,
  ) {}

  /** Formulaires proposés pour visiter un point de vente sans mission. */
  @Get('visit-forms')
  visitForms() {
    return this.visits.forms();
  }

  @Roles(Role.Admin)
  @Put('visit-forms')
  setVisitForms(@Body() dto: VisitFormsDto) {
    return this.visits.setForms(dto.typeIds);
  }

  /** Champs de la fiche, types de commerce et statuts. */
  @Get('form')
  form() {
    return this.outlets.form();
  }

  /** Champs de la fiche définis par la structure. */
  @Roles(Role.Admin)
  @Put('form')
  setFields(@Body() dto: OutletFieldsDto) {
    return this.outlets.setFields(dto.fields);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListOutletsQuery) {
    return this.outlets.list(user, query);
  }

  /** Tous les points localisés, en version légère, pour la carte. */
  @Get('map')
  map(@CurrentUser() user: AuthUser, @Query() query: OutletsMapQuery) {
    return this.outlets.map(user, query);
  }

  /** Modèle Excel d'import, avec les champs de la fiche. */
  @Roles(Role.Admin)
  @ApiProduces(XLSX)
  @Get('import/template')
  async template(@Res({ passthrough: true }) res: Response) {
    return send(res, await this.outlets.template());
  }

  /** Import Excel (.xlsx) ou CSV : les lignes écartées sont renvoyées avec leur motif. */
  @Roles(Role.Admin)
  @Post('import')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  import(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.outlets.import(user, file);
  }

  /** Export Excel ou CSV : formules qui incluent aussi les exports. */
  @Roles(Role.Admin, Role.TeamLead)
  @ApiProduces(XLSX, 'text/csv')
  @Get('export')
  async export(
    @CurrentUser() user: AuthUser,
    @Query() query: ExportOutletsQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.subscriptions.assertFeature(user.tenantId, Feature.Exports);
    return send(
      res,
      await this.outlets.export(user, query, req.originalUrl, req.ip),
    );
  }

  /**
   * Tournée optimisée depuis la position donnée : points de vente en retard de visite, ou
   * ceux qui restent à visiter dans une mission (missionId).
   */
  @Get('route')
  route(@CurrentUser() user: AuthUser, @Query() query: OutletRouteQuery) {
    return this.outlets.route(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.outlets.get(user, id);
  }

  /** Nouveau point de vente : position GPS obligatoire ; l'agent l'ajoute dans ses zones. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOutletDto) {
    return this.outlets.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOutletDto,
  ) {
    return this.outlets.update(user, id, dto);
  }

  /** Nouveau statut, avec un commentaire facultatif (historique conservé). */
  @Post(':id/status')
  @HttpCode(200)
  status(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeOutletStatusDto,
  ) {
    return this.outlets.changeStatus(user, id, dto);
  }

  /**
   * Visite libre (sans mission) : sur place, pendant la journée, avec un formulaire de visite
   * de la structure (relevés compris). Idempotente sur clientId.
   */
  @Roles(Role.Agent)
  @Post(':id/visits')
  visit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVisitDto,
  ) {
    return this.visits.visit(user, id, dto);
  }

  /** Historique des visites du point de vente ; `mine` : celles de l'agent. */
  @Get(':id/visits')
  visitHistory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: OutletVisitsQuery,
  ) {
    return this.visits.history(user, id, q);
  }

  /** Détail d'une visite : réponses, photos et relevé par produit. */
  @Get('visits/:submissionId')
  visitDetail(
    @CurrentUser() user: AuthUser,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
  ) {
    return this.visits.detail(user, submissionId);
  }

  /** Rejet d'une visite libre : elle ne compte plus. */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('visits/:submissionId/reject')
  @HttpCode(200)
  rejectVisit(
    @CurrentUser() user: AuthUser,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: RejectVisitDto,
  ) {
    return this.visits.reject(user, submissionId, dto.reason);
  }

  /** Fusion d'un doublon dans la fiche conservée. */
  @Roles(Role.Admin)
  @Post(':id/merge')
  @HttpCode(200)
  merge(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeOutletDto,
  ) {
    return this.outlets.merge(user, id, dto.intoId);
  }

  @Roles(Role.Admin)
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.outlets.remove(id);
  }
}
