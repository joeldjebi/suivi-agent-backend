import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../common/decorators';
import { RateLimit } from '../common/rate-limit';
import { PlatformRoute } from '../platform/platform-auth';
import { clientIp } from '../platform/platform-security';
import { ListViewsDto, RecordViewDto } from './video.dto';
import { VideoService } from './video.service';

/** Page publique /video : enregistre le temps de lecture (sans compte). */
@ApiTags('Vidéo de présentation')
@Public()
@Controller('public/video')
export class PublicVideoController {
  constructor(private readonly video: VideoService) {}

  @Post('view')
  @RateLimit(180, 60)
  @HttpCode(204)
  async record(@Body() dto: RecordViewDto, @Req() req: Request) {
    await this.video.record({
      viewId: dto.viewId,
      prospectId: dto.prospectId ?? null,
      seconds: dto.seconds,
      percent: dto.percent,
      duration: dto.duration ?? null,
      orientation: dto.orientation ?? null,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
      referer: (req.headers['referer'] as string | undefined) ?? null,
    });
  }
}

const hidden = process.env.NODE_ENV === 'production';

/** Console éditeur : statistiques de lecture de la vidéo de présentation. */
@ApiTags('Plateforme — vidéo')
@ApiExcludeController(hidden)
@PlatformRoute()
@Controller('platform/video-views')
export class PlatformVideoController {
  constructor(private readonly video: VideoService) {}

  @Get()
  list(@Query() query: ListViewsDto) {
    return this.video.list(query);
  }

  @Get('summary')
  summary() {
    return this.video.summary();
  }
}
