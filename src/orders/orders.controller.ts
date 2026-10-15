import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import {
  CatalogQuery,
  ChangeOrderStatusDto,
  CreateOrderDto,
  ListOrdersQuery,
  OrdersSummaryQuery,
  PriceListDto,
  SetPricesDto,
  UpdatePriceListDto,
} from './orders.dto';
import { OrdersService } from './orders.service';

/**
 * Prise de commande terrain : types de client et prix (administrateur), catalogue et prise de
 * commande (agent), suivi des commandes (prise → livrée → payée, ou annulée).
 */
@ApiTags('Commandes')
@ApiBearerAuth()
@RequiresFeature(Feature.Orders)
@Roles(Role.Admin, Role.TeamLead, Role.Agent)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Types de client (listes de tarifs) : Grossiste, Détaillant… */
  @Get('price-lists')
  priceLists() {
    return this.orders.priceLists();
  }

  @Roles(Role.Admin)
  @Post('price-lists')
  createPriceList(@Body() dto: PriceListDto) {
    return this.orders.createPriceList(dto);
  }

  @Roles(Role.Admin)
  @Patch('price-lists/:id')
  updatePriceList(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePriceListDto,
  ) {
    return this.orders.updatePriceList(id, dto);
  }

  /** Ses points de vente passent au type de client par défaut. */
  @Roles(Role.Admin)
  @Delete('price-lists/:id')
  @HttpCode(204)
  removePriceList(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.removePriceList(id);
  }

  /** Grille des prix : nos produits et leur prix pour chaque type de client. */
  @Roles(Role.Admin, Role.TeamLead)
  @Get('prices')
  prices() {
    return this.orders.prices();
  }

  /** Prix d'une unité de base ; null retire le prix (produit non proposé). */
  @Roles(Role.Admin)
  @Put('prices')
  setPrices(@Body() dto: SetPricesDto) {
    return this.orders.setPrices(dto);
  }

  /** Catalogue de l'agent pour un point de vente, aux prix de son type de client. */
  @Get('catalog')
  catalog(@CurrentUser() user: AuthUser, @Query() q: CatalogQuery) {
    return this.orders.catalog(user, q.outletId);
  }

  /** Commande prise chez le point de vente : prix calculés par le serveur. Idempotente. */
  @Roles(Role.Agent)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.orders.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListOrdersQuery) {
    return this.orders.list(user, q);
  }

  /** Nombre et montant des commandes de la période, par statut. */
  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query() q: OrdersSummaryQuery) {
    return this.orders.summary(user, q);
  }

  /** Produits vendus (commandes livrées ou payées) de la période, les plus commandés d'abord. */
  @Get('products')
  products(@CurrentUser() user: AuthUser, @Query() q: OrdersSummaryQuery) {
    return this.orders.products(user, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(user, id);
  }

  /** Livrée, payée ou annulée (motif obligatoire). */
  @Post(':id/status')
  @HttpCode(200)
  changeStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeOrderStatusDto,
  ) {
    return this.orders.changeStatus(user, id, dto);
  }
}
