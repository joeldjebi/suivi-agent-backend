import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators';
import { RateLimit } from '../common/rate-limit';
import {
  CurrentAdmin,
  PlatformRoute,
  type PlatformUser,
} from '../platform/platform-auth';
import {
  PresentationDefaultsQuery,
  SavePresentationDto,
} from './presentations.dto';
import { PresentationsService } from './presentations.service';

/** Présentation ouverte par son lien de partage, sans compte. */
@ApiTags('Présentations clients')
@Public()
@Controller('public/presentations')
export class PublicPresentationsController {
  constructor(private readonly presentations: PresentationsService) {}

  // Lien secret : on limite les essais au hasard.
  @RateLimit(60, 60)
  @Get(':token')
  @Header('Cache-Control', 'no-store')
  get(@Param('token') token: string) {
    return this.presentations.shared(token);
  }
}

const hidden = process.env.NODE_ENV === 'production';

/** Console éditeur : présentations clients générées à partir de leurs informations. */
@ApiTags('Plateforme — présentations clients')
@ApiExcludeController(hidden)
@PlatformRoute()
@Controller('platform/presentations')
export class PlatformPresentationsController {
  constructor(private readonly presentations: PresentationsService) {}

  @Get()
  list() {
    return this.presentations.list();
  }

  /** Valeurs de départ, pré-remplies avec une structure existante si elle est donnée. */
  @Get('defaults')
  defaults(
    @CurrentAdmin() admin: PlatformUser,
    @Query() query: PresentationDefaultsQuery,
  ) {
    return this.presentations.defaults(admin, query.tenantId);
  }

  @Post()
  create(
    @CurrentAdmin() admin: PlatformUser,
    @Body() dto: SavePresentationDto,
  ) {
    return this.presentations.create(admin, dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.presentations.get(id);
  }

  @Patch(':id')
  update(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SavePresentationDto,
  ) {
    return this.presentations.update(admin, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.presentations.remove(admin, id);
  }

  @Post(':id/share')
  @HttpCode(200)
  share(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.presentations.share(admin, id);
  }

  /** Structure de démonstration du client, créée en un clic (mot de passe montré une fois). */
  @Post(':id/demo')
  createDemo(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.presentations.createDemo(admin, id);
  }

  @Get(':id/demo')
  demo(@Param('id', ParseUUIDPipe) id: string) {
    return this.presentations.demo(id);
  }

  @Post(':id/demo/password')
  @HttpCode(200)
  resetDemoPassword(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.presentations.resetDemoPassword(admin, id);
  }

  @Delete(':id/demo')
  deleteDemo(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.presentations.deleteDemo(admin, id);
  }

  @Delete(':id/share')
  unshare(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.presentations.unshare(admin, id);
  }
}
