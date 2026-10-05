import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import { Roles } from '../common/decorators';
import { BillingQuery } from './billing.dto';
import { BillingService } from './billing.service';

@ApiTags('Facturation')
@ApiBearerAuth()
@Roles(Role.Admin)
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /**
   * Agents actifs du mois : ceux qui ont démarré au moins une journée (RG-40 à RG-42).
   * Le total facturé porte sur tout le mois ; les filtres ne changent que la liste.
   */
  @Get('active-agents')
  activeAgents(@Query() query: BillingQuery) {
    return this.billing.activeAgents(query);
  }
}
