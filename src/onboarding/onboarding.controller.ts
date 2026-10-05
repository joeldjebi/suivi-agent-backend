import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import { Roles } from '../common/decorators';
import { UpdateOnboardingDto } from './onboarding.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('Bien démarrer')
@ApiBearerAuth()
@Roles(Role.Admin)
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  /** Étapes de mise en route de la structure et leur avancement. */
  @Get()
  state() {
    return this.onboarding.state();
  }

  /** Coche une étape manuelle, ou masque / réaffiche le guide. */
  @Patch()
  update(@Body() dto: UpdateOnboardingDto) {
    return this.onboarding.update(dto);
  }
}
