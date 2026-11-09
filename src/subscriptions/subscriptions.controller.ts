import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { AllowWhenSuspended, CurrentUser, Roles } from '../common/decorators';
import { ChangePlanDto, OnboardingRequestDto } from './subscriptions.dto';
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

  /** Demandes de mise en place de la structure, les plus récentes d'abord. */
  @Get('onboarding-requests')
  onboardingRequests() {
    return this.subscriptions.onboardingRequests();
  }

  /** Demander un forfait de mise en place : l'éditeur l'accepte ou le refuse. */
  @Post('onboarding-requests')
  requestOnboarding(
    @CurrentUser() user: AuthUser,
    @Body() dto: OnboardingRequestDto,
  ) {
    return this.subscriptions.requestOnboarding(user, dto);
  }

  /** Retirer une demande encore en attente. */
  @Post('onboarding-requests/:id/cancel')
  @HttpCode(200)
  cancelOnboarding(@Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptions.cancelOnboarding(id);
  }
}
