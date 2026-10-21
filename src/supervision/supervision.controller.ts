import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { RateLimit } from '../common/rate-limit';
import { PlatformRoute } from '../platform/platform-auth';
import { SupervisionService } from './supervision.service';

/** Page « Supervision » de la console éditeur. */
@ApiTags('Plateforme')
@ApiExcludeController(process.env.NODE_ENV === 'production')
@PlatformRoute()
@Controller('platform/supervision')
export class SupervisionController {
  constructor(private readonly supervision: SupervisionService) {}

  /** `?refresh=1` relit les outils externes sans attendre la fin du cache. */
  @RateLimit(30, 60)
  @Get()
  @Header('Cache-Control', 'no-store')
  overview(@Query('refresh') refresh?: string) {
    return this.supervision.overview(refresh === '1' || refresh === 'true');
  }
}
