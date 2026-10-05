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
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators';
import {
  CurrentAdmin,
  PlatformRoute,
  type PlatformUser,
} from '../platform/platform-auth';
import { clientIp } from '../platform/platform-security';
import {
  DemoRequestDto,
  ListDemoRequestsQuery,
  SaveLandingDto,
  UpdateDemoRequestDto,
} from './landing.dto';
import { LandingService, MAX_ASSET_BYTES } from './landing.service';

/** Site vitrine public : contenu publié, images, demandes de démo. */
@ApiTags('Site vitrine')
@Public()
@Controller('public')
export class PublicLandingController {
  constructor(private readonly landing: LandingService) {}

  @Get('landing')
  @Header('Cache-Control', 'public, max-age=60')
  get() {
    return this.landing.publicLanding();
  }

  @Get('landing/assets/:id')
  async asset(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { mime, data } = await this.landing.asset(id);
    // Une image ne change jamais : son identifiant change à chaque envoi.
    res.set({
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return new StreamableFile(data);
  }

  @Post('demo-requests')
  @HttpCode(201)
  requestDemo(@Body() dto: DemoRequestDto, @Req() req: Request) {
    return this.landing.requestDemo(dto, clientIp(req));
  }
}

const hidden = process.env.NODE_ENV === 'production';

/** Console éditeur : modification du site et suivi des demandes de démo. */
@ApiTags('Plateforme — site vitrine')
@ApiExcludeController(hidden)
@PlatformRoute()
@Controller('platform')
export class PlatformLandingController {
  constructor(private readonly landing: LandingService) {}

  @Get('landing')
  editor() {
    return this.landing.editor();
  }

  @Get('landing/preview')
  preview() {
    return this.landing.preview();
  }

  @Put('landing')
  save(@CurrentAdmin() admin: PlatformUser, @Body() dto: SaveLandingDto) {
    return this.landing.saveDraft(admin, dto.content);
  }

  @Post('landing/publish')
  @HttpCode(200)
  publish(@CurrentAdmin() admin: PlatformUser) {
    return this.landing.publish(admin);
  }

  @Delete('landing/draft')
  discard(@CurrentAdmin() admin: PlatformUser) {
    return this.landing.discard(admin);
  }

  @Post('landing/restore-defaults')
  @HttpCode(200)
  restoreDefaults(@CurrentAdmin() admin: PlatformUser) {
    return this.landing.restoreDefaults(admin);
  }

  @Post('landing/assets')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ASSET_BYTES * 2 } }),
  )
  upload(
    @CurrentAdmin() admin: PlatformUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.landing.uploadAsset(admin, file);
  }

  @Get('demo-requests')
  demoRequests(@Query() query: ListDemoRequestsQuery) {
    return this.landing.demoRequests(query);
  }

  @Patch('demo-requests/:id')
  updateDemoRequest(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDemoRequestDto,
  ) {
    return this.landing.updateDemoRequest(admin, id, dto);
  }
}
