import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import { StockService } from './stock.service';
import {
  CancelDto,
  CashQuery,
  ConfirmMovementDto,
  CreateLocationDto,
  CreatePaymentDto,
  CreateSaleDto,
  CreditLimitDto,
  InventoryDto,
  LoadDto,
  LossDto,
  MovementsQuery,
  OutletSearchQuery,
  ReceiptDto,
  RemittanceDto,
  UnloadDto,
  UpdateLocationDto,
  VanHistoryQuery,
} from './van-sales.dto';
import { VanSalesService } from './van-sales.service';

/**
 * Stock de la vente en camionnette : dépôts et camions (administrateur), stock, chargements
 * (responsables, confirmés par l'agent), retours (agent, confirmés par un responsable),
 * pertes et inventaires.
 */
@ApiTags('Vente en camionnette — stock')
@ApiBearerAuth()
@RequiresFeature(Feature.VanSales)
@Roles(Role.Admin, Role.TeamLead, Role.Agent)
@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get('locations')
  locations(@CurrentUser() user: AuthUser) {
    return this.stock.locations(user);
  }

  @Roles(Role.Admin)
  @Post('locations')
  createLocation(@Body() dto: CreateLocationDto) {
    return this.stock.createLocation(dto);
  }

  @Roles(Role.Admin)
  @Patch('locations/:id')
  updateLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.stock.updateLocation(id, dto);
  }

  /** Stock par produit ; `locationId` pour un seul emplacement. L'agent : son camion. */
  @Get('levels')
  levels(
    @CurrentUser() user: AuthUser,
    @Query('locationId', new ParseUUIDPipe({ optional: true }))
    locationId?: string,
  ) {
    return this.stock.levels(user, locationId);
  }

  @Get('movements')
  movements(@CurrentUser() user: AuthUser, @Query() q: MovementsQuery) {
    return this.stock.movements(user, q);
  }

  @Get('movements/:id')
  movement(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.stock.movement(user, id);
  }

  /** Entrée au dépôt (livraison du fournisseur, production). */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('receipts')
  receipt(@CurrentUser() user: AuthUser, @Body() dto: ReceiptDto) {
    return this.stock.receipt(user, dto);
  }

  /** Chargement d'un camion : l'agent le confirme à la réception. */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('loads')
  load(@CurrentUser() user: AuthUser, @Body() dto: LoadDto) {
    return this.stock.load(user, dto);
  }

  /** Retour au dépôt : un responsable le confirme. Idempotent (clientId). */
  @Post('unloads')
  unload(@CurrentUser() user: AuthUser, @Body() dto: UnloadDto) {
    return this.stock.unload(user, dto);
  }

  /** Quantités réellement reçues ; sans lignes : tout est arrivé. */
  @Post('movements/:id/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmMovementDto,
  ) {
    return this.stock.confirm(user, id, dto);
  }

  @Post('movements/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelDto,
  ) {
    return this.stock.cancel(user, id, dto.reason);
  }

  /** Casse, perte, vol (motif obligatoire). Idempotent (clientId). */
  @Post('losses')
  loss(@CurrentUser() user: AuthUser, @Body() dto: LossDto) {
    return this.stock.loss(user, dto);
  }

  /** Inventaire : les quantités comptées remplacent le stock. */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('inventories')
  inventory(@CurrentUser() user: AuthUser, @Body() dto: InventoryDto) {
    return this.stock.inventory(user, dto);
  }
}

/**
 * Ventes directes depuis le camion, paiements et crédit des clients, caisse des agents et
 * reçus PDF.
 */
@ApiTags('Vente en camionnette')
@ApiBearerAuth()
@RequiresFeature(Feature.VanSales)
@Roles(Role.Admin, Role.TeamLead, Role.Agent)
@Controller('van-sales')
export class VanSalesController {
  constructor(private readonly sales: VanSalesService) {}

  /** « Mon camion » : stock, chargements à confirmer, journée, caisse. */
  @Roles(Role.Agent)
  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.sales.mine(user);
  }

  /**
   * Historique de mon camion, par onglet (ventes, approvisionnements, dépannages, casse ou
   * perte, retours au dépôt), filtré, avec les totaux de la période.
   */
  @Roles(Role.Agent)
  @Get('history')
  history(@CurrentUser() user: AuthUser, @Query() q: VanHistoryQuery) {
    return this.sales.history(user, q);
  }

  /**
   * Clients de toute la structure (vente d'urgence hors zone) : par nom ou les plus proches ;
   * « inScope » dit si le client est déjà dans le périmètre de l'agent.
   */
  @Roles(Role.Agent)
  @Get('outlets/search')
  searchOutlets(@CurrentUser() user: AuthUser, @Query() q: OutletSearchQuery) {
    return this.sales.searchOutlets(user, q);
  }

  /**
   * Vente d'urgence hors zone : le client choisi (hors du périmètre de l'agent), ses prix et
   * son crédit, pour préparer la vente dans l'app.
   */
  @Roles(Role.Agent)
  @Get('outlets/:id/out-of-zone')
  outOfZone(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sales.outOfZoneContext(user, id);
  }

  /** Vente directe : prix, stock et crédit vérifiés par le serveur. Idempotente (clientId). */
  @Roles(Role.Agent)
  @Post('sales')
  sell(@CurrentUser() user: AuthUser, @Body() dto: CreateSaleDto) {
    return this.sales.sell(user, dto);
  }

  /** Annulation : marchandise rendue au camion, argent rendu au client. */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('sales/:id/cancel')
  @HttpCode(200)
  cancelSale(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelDto,
  ) {
    return this.sales.cancelSale(user, id, dto.reason);
  }

  /** Reçu PDF d'une vente ou d'une commande. */
  @Get('orders/:id/receipt')
  async receipt(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const { pdf, filename } = await this.sales.receipt(user, id);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="${filename}"`,
    });
  }

  /** Solde d'un point de vente : dû, avance, plafond, crédit possible, commandes dues. */
  @Get('outlets/:id/balance')
  balance(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sales.balance(user, id);
  }

  /** Plafond de crédit ; null : pas de vente à crédit. */
  @Roles(Role.Admin)
  @Put('outlets/:id/credit-limit')
  setCreditLimit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreditLimitDto,
  ) {
    return this.sales.setCreditLimit(id, dto.limit);
  }

  /** Paiement reçu d'un client : il règle ses commandes dues. Idempotent (clientId). */
  @Post('payments')
  pay(@CurrentUser() user: AuthUser, @Body() dto: CreatePaymentDto) {
    return this.sales.pay(user, dto);
  }

  /** Caisse du jour par agent (l'agent : la sienne). */
  @Get('cash')
  cash(@CurrentUser() user: AuthUser, @Query() q: CashQuery) {
    return this.sales.cash(user, q);
  }

  /** Remise de caisse : le responsable reçoit l'argent liquide de l'agent. */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('remittances')
  remit(@CurrentUser() user: AuthUser, @Body() dto: RemittanceDto) {
    return this.sales.remit(user, dto);
  }
}
