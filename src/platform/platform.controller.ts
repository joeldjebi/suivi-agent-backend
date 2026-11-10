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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../common/decorators';
import {
  AuditQuery,
  CreatePlanDto,
  CreatePlatformAdminDto,
  MfaCodeDto,
  MfaDisableDto,
  PlatformMfaLoginDto,
  CreateTenantDto,
  ListInvoicesQuery,
  ErrorLogQuery,
  ListTenantsQuery,
  ResolveErrorDto,
  PlatformLoginDto,
  PlatformPasswordDto,
  OneTimeChargeDto,
  OnboardingRequestsQuery,
  AcceptOnboardingDto,
  RejectOnboardingDto,
  RegistrationsQuery,
  RejectRegistrationDto,
  ApproveRegistrationDto,
  PhotoAiBonusDto,
  PlatformSubscriptionDto,
  RecordPaymentDto,
  SuspendDto,
  TenantActivityQuery,
  TenantUsersQuery,
  UpdatePlanDto,
  UpdatePlatformAdminDto,
  UpdatePlatformProfileDto,
  UpdatePlatformSettingsDto,
  UpdateTenantDto,
  VoidInvoiceDto,
  DeleteTenantDto,
} from './platform.dto';
import {
  AllowWithoutMfa,
  CurrentAdmin,
  PlatformRoute,
  type PlatformUser,
} from './platform-auth';
import { ErrorLogService } from '../error-log/error-log.service';
import { PhotoAiService } from '../photo-ai/photo-ai.service';
import { PlatformService } from './platform.service';
import { PlatformTenantService } from './platform-tenant.service';
import { clientIp, PlatformIpGuard } from './platform-security';

/** En production, l'espace éditeur n'apparaît pas dans la documentation publique de l'API. */
const hidden = process.env.NODE_ENV === 'production';

/**
 * Connexion de l'éditeur (super administrateur), distincte de celle des structures.
 * Ces routes restent ouvertes tant que la double authentification n'est pas en place.
 */
@ApiTags('Plateforme — connexion')
@AllowWithoutMfa()
@ApiExcludeController(hidden)
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly platform: PlatformService) {}

  @Public()
  @UseGuards(PlatformIpGuard)
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: PlatformLoginDto, @Req() req: Request) {
    return this.platform.login(dto, clientIp(req), {
      userAgent: req.headers['user-agent'],
      referer: req.headers['referer'],
      path: '/platform/auth/login',
    });
  }

  /** Deuxième étape de connexion, quand la double authentification est active. */
  @Public()
  @UseGuards(PlatformIpGuard)
  @Post('login/mfa')
  @HttpCode(200)
  loginMfa(@Body() dto: PlatformMfaLoginDto, @Req() req: Request) {
    return this.platform.loginMfa(dto, clientIp(req));
  }

  @PlatformRoute()
  @Post('mfa/setup')
  @HttpCode(200)
  mfaSetup(@CurrentAdmin() admin: PlatformUser) {
    return this.platform.mfaSetup(admin);
  }

  @PlatformRoute()
  @Post('mfa/enable')
  @HttpCode(200)
  mfaEnable(@CurrentAdmin() admin: PlatformUser, @Body() dto: MfaCodeDto) {
    return this.platform.mfaEnable(admin, dto.code);
  }

  @PlatformRoute()
  @Post('mfa/recovery-codes')
  @HttpCode(200)
  mfaRecoveryCodes(
    @CurrentAdmin() admin: PlatformUser,
    @Body() dto: MfaCodeDto,
  ) {
    return this.platform.mfaRecoveryCodes(admin, dto.code);
  }

  @PlatformRoute()
  @Post('mfa/disable')
  @HttpCode(200)
  mfaDisable(@CurrentAdmin() admin: PlatformUser, @Body() dto: MfaDisableDto) {
    return this.platform.mfaDisable(admin, dto);
  }

  @PlatformRoute()
  @Patch('profile')
  profile(
    @CurrentAdmin() admin: PlatformUser,
    @Body() dto: UpdatePlatformProfileDto,
  ) {
    return this.platform.updateProfile(admin, dto);
  }

  @PlatformRoute()
  @Get('me')
  me(@CurrentAdmin() admin: PlatformUser) {
    return this.platform.me(admin);
  }

  @PlatformRoute()
  @Post('logout')
  @HttpCode(204)
  logout(@CurrentAdmin() admin: PlatformUser) {
    return this.platform.logout(admin);
  }

  @PlatformRoute()
  @Patch('password')
  password(
    @CurrentAdmin() admin: PlatformUser,
    @Body() dto: PlatformPasswordDto,
  ) {
    return this.platform.changePassword(admin, dto);
  }
}

/** Espace de l'éditeur : toutes les structures, leurs abonnements et leurs factures. */
@ApiTags('Plateforme')
@ApiExcludeController(hidden)
@PlatformRoute()
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly tenantData: PlatformTenantService,
    private readonly errors: ErrorLogService,
    private readonly photoAi: PhotoAiService,
  ) {}

  @Get('dashboard')
  dashboard() {
    return this.platform.dashboard();
  }

  // Journal des erreurs (API, site, app)

  @Get('errors')
  async errorLog(@Query() query: ErrorLogQuery) {
    await this.errors.prune();
    return {
      items: await this.errors.list(query.status ?? 'open', query.source),
      summary: await this.errors.summary(),
      // Lien vers les erreurs dans Sentry, s'il est configuré.
      sentryUrl: process.env.SENTRY_ISSUES_URL || null,
    };
  }

  @Get('errors/summary')
  errorSummary() {
    return this.errors.summary();
  }

  /** Corrigée (ou rouverte) : une erreur close qui se reproduit revient d'elle-même. */
  @Post('errors/:id/resolve')
  @HttpCode(204)
  resolveError(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveErrorDto,
  ) {
    return this.errors.resolve(id, dto.resolved ?? true);
  }

  // Structures

  @Get('tenants')
  tenants(@Query() query: ListTenantsQuery) {
    return this.platform.tenants(query);
  }

  @Post('tenants')
  createTenant(
    @CurrentAdmin() admin: PlatformUser,
    @Body() dto: CreateTenantDto,
  ) {
    return this.platform.createTenant(admin, dto);
  }

  @Get('tenants/:id')
  tenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.tenant(id);
  }

  @Get('tenants/:id/users')
  tenantUsers(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TenantUsersQuery,
  ) {
    return this.tenantData.users(id, query);
  }

  @Get('tenants/:id/groups')
  tenantGroups(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantData.groups(id);
  }

  /** Zones, activité quotidienne, missions : jamais les positions des agents. */
  @Get('tenants/:id/field')
  tenantField(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantData.field(id);
  }

  @Get('tenants/:id/config')
  tenantConfig(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantData.config(id);
  }

  /** Demandes de mise en place des structures (à traiter par défaut), et le nombre en attente. */
  @Get('onboarding-requests')
  onboardingRequests(@Query() query: OnboardingRequestsQuery) {
    return this.platform.onboardingRequests(query);
  }

  /** Accepter : les frais s'ajoutent à la prochaine facture de la structure. */
  @Post('onboarding-requests/:id/accept')
  @HttpCode(200)
  acceptOnboarding(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptOnboardingDto,
  ) {
    return this.platform.acceptOnboarding(admin, id, dto);
  }

  @Post('onboarding-requests/:id/reject')
  @HttpCode(200)
  rejectOnboarding(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectOnboardingDto,
  ) {
    return this.platform.rejectOnboarding(admin, id, dto.reason);
  }

  // ------------------------------------------- validation des inscriptions

  @Get('registrations')
  registrations(@Query() query: RegistrationsQuery) {
    return this.platform.registrations(query);
  }

  /** Valider une inscription : la structure est activée et son essai démarre. */
  @Post('registrations/:id/approve')
  @HttpCode(200)
  approveRegistration(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveRegistrationDto,
  ) {
    return this.platform.approveRegistration(admin, id, dto);
  }

  @Post('registrations/:id/reject')
  @HttpCode(200)
  rejectRegistration(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectRegistrationDto,
  ) {
    return this.platform.rejectRegistration(admin, id, dto.reason);
  }

  /** Frais ponctuels (mise en place) ajoutés à la prochaine facture. */
  @Post('tenants/:id/charges')
  addCharge(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OneTimeChargeDto,
  ) {
    return this.platform.addCharge(admin, id, dto);
  }

  @Delete('tenants/:id/charges/:chargeId')
  @HttpCode(204)
  removeCharge(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
  ) {
    return this.platform.removeCharge(admin, id, chargeId);
  }

  /** IA photo : photos accordées en plus du quota ce mois-ci. */
  @Put('tenants/:id/photo-ai-bonus')
  setPhotoAiBonus(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PhotoAiBonusDto,
  ) {
    return this.platform.setPhotoAiBonus(admin, id, dto.photos, dto.note);
  }

  @Get('tenants/:id/activity')
  tenantActivity(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TenantActivityQuery,
  ) {
    return this.tenantData.activity(id, query);
  }

  @Patch('tenants/:id')
  updateTenant(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.platform.updateTenant(admin, id, dto);
  }

  @Patch('tenants/:id/subscription')
  updateSubscription(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlatformSubscriptionDto,
  ) {
    return this.platform.updateSubscription(admin, id, dto);
  }

  @Post('tenants/:id/suspend')
  @HttpCode(200)
  suspend(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendDto,
  ) {
    return this.platform.suspend(admin, id, dto.reason);
  }

  /** Suppression définitive (compte propriétaire seulement) : la structure et toutes ses données. */
  @Post('tenants/:id/delete')
  @HttpCode(200)
  deleteTenant(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteTenantDto,
  ) {
    return this.platform.deleteTenant(admin, id, dto);
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(200)
  reactivate(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.platform.reactivate(admin, id);
  }

  // Factures

  @Get('invoices')
  invoices(@Query() query: ListInvoicesQuery) {
    return this.platform.invoices(query);
  }

  /** Paiement reçu hors plateforme (Mobile Money, virement, espèces). */
  @Post('invoices/:id/payment')
  @HttpCode(200)
  recordPayment(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordPaymentDto,
  ) {
    return this.platform.recordPayment(admin, id, dto);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  voidInvoice(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
  ) {
    return this.platform.voidInvoice(admin, id, dto.reason);
  }

  // Catalogue et réglages

  @Get('plans')
  plans() {
    return this.platform.plans();
  }

  @Post('plans')
  createPlan(@CurrentAdmin() admin: PlatformUser, @Body() dto: CreatePlanDto) {
    return this.platform.createPlan(admin, dto);
  }

  @Delete('plans/:code')
  @HttpCode(204)
  deletePlan(@CurrentAdmin() admin: PlatformUser, @Param('code') code: string) {
    return this.platform.deletePlan(admin, code);
  }

  @Patch('plans/:code')
  updatePlan(
    @CurrentAdmin() admin: PlatformUser,
    @Param('code') code: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.platform.updatePlan(admin, code, dto);
  }

  /** IA photo : fournisseurs branchés, choix actif, analyses et coût du mois. */
  @Get('photo-ai')
  photoAiOverview() {
    return this.photoAi.overview();
  }

  @Get('settings')
  settings() {
    return this.platform.settings();
  }

  @Patch('settings')
  updateSettings(
    @CurrentAdmin() admin: PlatformUser,
    @Body() dto: UpdatePlatformSettingsDto,
  ) {
    return this.platform.updateSettings(admin, dto);
  }

  // Comptes de l'éditeur et journal

  @Get('admins')
  admins() {
    return this.platform.admins();
  }

  @Post('admins')
  createAdmin(
    @CurrentAdmin() admin: PlatformUser,
    @Body() dto: CreatePlatformAdminDto,
  ) {
    return this.platform.createAdmin(admin, dto);
  }

  @Patch('admins/:id')
  updateAdmin(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlatformAdminDto,
  ) {
    return this.platform.updateAdmin(admin, id, dto.isActive);
  }

  @Delete('admins/:id')
  @HttpCode(204)
  removeAdmin(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.platform.removeAdmin(admin, id);
  }

  /** Téléphone perdu : réinitialise la double authentification d'un autre compte éditeur. */
  @Post('admins/:id/mfa-reset')
  @HttpCode(200)
  resetAdminMfa(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.platform.resetAdminMfa(admin, id);
  }

  @Get('audit')
  audit(@Query() query: AuditQuery) {
    return this.platform.audit(query);
  }
}
