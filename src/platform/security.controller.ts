import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SecurityEventsService } from '../common/security-events.service';
import { PlatformRoute } from './platform-auth';
import { AttackersQueryDto, SecurityEventsQueryDto } from './platform.dto';

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

  /** Attaquants regroupés par adresse IP (nombre, types, période, cibles, géolocalisation). */
  @Get('security-events/attackers')
  attackers(@Query() query: AttackersQueryDto) {
    return this.security.attackers(query);
  }

  /** Détail d'un événement (user-agent, chemin, referer, détails, géolocalisation de l'IP). */
  @Get('security-events/:id')
  async detail(@Param('id') id: string) {
    const event = await this.security.detail(id);
    if (!event) throw new NotFoundException();
    return event;
  }

  /** Liste filtrable des événements, la plus récente d'abord. */
  @Get('security-events')
  list(@Query() query: SecurityEventsQueryDto) {
    return this.security.list(query);
  }
}
