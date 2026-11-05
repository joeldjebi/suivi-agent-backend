import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import { MAX_PHOTO_BYTES } from '../photos/photos.service';
import { PhotoAiStatsQuery } from './photo-ai.dto';
import { PhotoAiService } from './photo-ai.service';

/** IA photo : quota du mois, analyse d'une photo de rayon, nouvelle analyse demandée. */
@ApiTags('IA photo')
@ApiBearerAuth()
@RequiresFeature(Feature.PhotoAi)
@Roles(Role.Admin, Role.TeamLead, Role.Agent)
@Controller('photo-ai')
export class PhotoAiController {
  constructor(private readonly ai: PhotoAiService) {}

  /** Photos analysées ce mois-ci, quota, supplément, analyse automatique. */
  @Get('usage')
  usage(@CurrentUser() user: AuthUser) {
    return this.ai.usage(user.tenantId);
  }

  /** Résultat (ou état) de l'analyse d'une photo : l'app l'interroge pour pré-remplir. */
  @Get('photos/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.get(user, id);
  }

  /** Analyse (ou nouvelle analyse) demandée par un responsable. */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('photos/:id/analyze')
  @HttpCode(202)
  analyze(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ai.request(user, id);
  }

  /** Rayons : score, part de rayon, présence par produit, dernier état des points de vente. */
  @Roles(Role.Admin, Role.TeamLead)
  @Get('stats')
  stats(@CurrentUser() user: AuthUser, @Query() q: PhotoAiStatsQuery) {
    return this.ai.stats(user, q);
  }

  /** Photo de référence d'un produit (aide l'IA à le reconnaître). */
  @Roles(Role.Admin)
  @Put('products/:id/reference')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES * 2 } }),
  )
  setReference(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.ai.setReference(user, id, file);
  }

  @Roles(Role.Admin)
  @Delete('products/:id/reference')
  @HttpCode(204)
  async removeReference(@Param('id', ParseUUIDPipe) id: string) {
    await this.ai.removeReference(id);
  }
}
