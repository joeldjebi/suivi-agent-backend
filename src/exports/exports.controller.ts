import {
  Controller,
  Get,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { Request, Response } from 'express';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import { DaysExportQuery, SubmissionsExportQuery } from './exports.dto';
import { type ExportFile, ExportsService } from './exports.service';

const send = (res: Response, file: ExportFile) => {
  res.set({
    'Content-Type': file.mime,
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    'Cache-Control': 'no-store',
  });
  return new StreamableFile(file.data);
};

/** Exports Excel (par défaut) ou CSV : formules qui incluent les exports. */
@ApiTags('Exports')
@ApiBearerAuth()
@RequiresFeature(Feature.Exports)
@Roles(Role.Admin, Role.TeamLead)
@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  /** Journées de travail d'une période : horaires, pauses, temps travaillé, sorties de zone. */
  @ApiProduces(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
  )
  @Get('days')
  async days(
    @CurrentUser() user: AuthUser,
    @Query() query: DaysExportQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(
      res,
      await this.exports.days(user, query, req.originalUrl, req.ip),
    );
  }

  /** Formulaires d'une mission ou d'un type : une colonne par champ du formulaire. */
  @ApiProduces(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
  )
  @Get('submissions')
  async submissions(
    @CurrentUser() user: AuthUser,
    @Query() query: SubmissionsExportQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(
      res,
      await this.exports.submissions(user, query, req.originalUrl, req.ip),
    );
  }
}
