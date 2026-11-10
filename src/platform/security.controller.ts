import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SecurityEventsService } from '../common/security-events.service';
import { PlatformRoute } from './platform-auth';
import { SecurityEventsQueryDto } from './platform.dto';

/**
 * Journal de sécurité réservé à l'éditeur : les « attaques » sur la plateforme (connexions
 * refusées, verrouillages, dépassements de débit, échecs CAPTCHA, robots).
 */
@ApiTags('Plateforme — sécurité')
@PlatformRoute()
@Controller('platform')
export class PlatformSecurityController {
  constructor(private readonly security: SecurityEventsService) {}

  /** Compteurs par type (24 h / 7 j), principales adresses IP et série pour le graphe. */
  @Get('security-events/summary')
  summary() {
    return this.security.summary();
  }

  /** Liste filtrable des événements, la plus récente d'abord. */
  @Get('security-events')
  list(@Query() query: SecurityEventsQueryDto) {
    return this.security.list(query);
  }
}
