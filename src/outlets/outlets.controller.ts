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
  CreateOutletDto,
  ExportOutletsQuery,
  ListOutletsQuery,
  MergeOutletDto,
  OutletFieldsDto,
  OutletsMapQuery,
  UpdateOutletDto,
} from './outlets.dto';
import { OutletsService } from './outlets.service';

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
  ) {}

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
