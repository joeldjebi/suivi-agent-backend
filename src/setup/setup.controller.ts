import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { ApplySetupDto } from './setup.dto';
import { SetupService } from './setup.service';

@ApiTags('Assistant de démarrage')
@ApiBearerAuth()
@Roles(Role.Admin)
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  /** Métiers (formulaires prêts à l'emploi) et communes proposés. */
  @Get('catalog')
  catalog() {
    return this.setup.catalog();
  }

  /** L'assistant est-il à proposer ? */
  @Get('status')
  status() {
    return this.setup.status();
  }

  /** Crée zones, formulaires, première mission et agents en une fois. */
  @Post()
  apply(@CurrentUser() user: AuthUser, @Body() dto: ApplySetupDto) {
    return this.setup.apply(user, dto);
  }

  /** « Je configurerai plus tard » : l'assistant ne s'ouvre plus de lui-même. */
  @Post('skip')
  skip() {
    return this.setup.skip();
  }
}
