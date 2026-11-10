import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import { AllowWhenSuspended, Roles } from '../common/decorators';
import { ChangePlanDto } from './subscriptions.dto';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('Abonnement')
@ApiBearerAuth()
@Roles(Role.Admin)
@AllowWhenSuspended()
@Controller('subscription')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  /** Formule, essai, estimation du mois en cours, catalogue des formules, impayés. */
  @Get()
  details() {
    return this.subscriptions.details();
  }

  /** Changer de formule ou passer à l'engagement annuel (remise). */
  @Patch()
  change(@Body() dto: ChangePlanDto) {
    return this.subscriptions.change(dto);
  }

  @Get('invoices')
  invoices() {
    return this.subscriptions.invoices();
  }
}
