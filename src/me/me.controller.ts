import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { MeService } from './me.service';

@ApiTags('Mon équipe (agent)')
@ApiBearerAuth()
@Roles(Role.Agent)
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  /** Groupe, chef(s) d'équipe à contacter et zones accessibles de l'agent. */
  @Get('team')
  team(@CurrentUser() user: AuthUser) {
    return this.me.team(user);
  }
}
