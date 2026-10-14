import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import { InsightsQuery } from './insights.dto';
import { InsightsService } from './insights.service';

/** Tableaux de bord des relevés produits : administrateur, et chef pour son équipe. */
@ApiTags('Analyses produits')
@ApiBearerAuth()
@RequiresFeature(Feature.ProductAudits)
@Roles(Role.Admin, Role.TeamLead)
@Controller('insights/products')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('overview')
  overview(@CurrentUser() user: AuthUser, @Query() q: InsightsQuery) {
    return this.insights.overview(user, q);
  }

  @Get('stockouts')
  stockouts(@CurrentUser() user: AuthUser, @Query() q: InsightsQuery) {
    return this.insights.stockouts(user, q);
  }

  @Get('sales')
  sales(@CurrentUser() user: AuthUser, @Query() q: InsightsQuery) {
    return this.insights.sales(user, q);
  }

  @Get('prices')
  prices(@CurrentUser() user: AuthUser, @Query() q: InsightsQuery) {
    return this.insights.prices(user, q);
  }

  /** Point de vente : dernier relevé de chaque produit et évolution du stock. */
  @Get('outlets/:id')
  outlet(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.insights.outlet(user, id);
  }
}
