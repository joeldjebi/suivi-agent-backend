import { AppOnboardingModule } from './app-onboarding/app-onboarding.module';
import { MeModule } from './me/me.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { ReportsModule } from './reports/reports.module';
import { ExportsModule } from './exports/exports.module';
import { DocsModule } from './docs/docs.module';
import { SupportModule } from './support/support.module';
import { AlertsModule } from './alerts/alerts.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SyncInterceptor } from './common/sync.interceptor';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { BrandingModule } from './branding/branding.module';
import { AuditInterceptor } from './common/audit.interceptor';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard, RolesGuard } from './common/guards';
import { QueryFailedFilter } from './common/query-failed.filter';
import { TenantTransactionInterceptor } from './common/tenant-transaction.interceptor';
import { DaysModule } from './days/days.module';
import { ENTITIES } from './entities';
import { GroupsModule } from './groups/groups.module';
import { JobsModule } from './jobs/jobs.module';
import { MissionsModule } from './missions/missions.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PositionsModule } from './positions/positions.module';
import { RealtimeModule } from './realtime/realtime.module';
import { PayrollModule } from './payroll/payroll.module';
import { PlatformModule } from './platform/platform.module';
import { LandingModule } from './landing/landing.module';
import { SettingsModule } from './settings/settings.module';
import { StatsModule } from './stats/stats.module';
import { SubscriptionGuard } from './subscriptions/subscription.guard';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { TeamLeadsModule } from './team-leads/team-leads.module';
import { UsersModule } from './users/users.module';
import { ZoneRequestsModule } from './zone-requests/zone-requests.module';
import { ZonesModule } from './zones/zones.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DATABASE_HOST'),
        port: Number(config.get('DATABASE_PORT')),
        // Rôle applicatif sans privilège : la Row Level Security s'applique.
        username: config.get<string>('DATABASE_APP_USER'),
        password: config.get<string>('DATABASE_APP_PASSWORD'),
        database: config.get<string>('DATABASE_NAME'),
        entities: ENTITIES,
        // Le schéma est géré par des migrations, jamais synchronisé automatiquement.
        synchronize: false,
        extra: { max: Number(config.get('DATABASE_POOL_SIZE') ?? 20) },
      }),
    }),
    ScheduleModule.forRoot(),
    CommonModule,
    AuthModule,
    SettingsModule,
    UsersModule,
    GroupsModule,
    ZonesModule,
    AlertsModule,
    SupportModule,
    ExportsModule,
    ReportsModule,
    OnboardingModule,
    AppOnboardingModule,
    MeModule,
    DocsModule,
    ZoneRequestsModule,
    DaysModule,
    PositionsModule,
    MissionsModule,
    NotificationsModule,
    AuditModule,
    BillingModule,
    TeamLeadsModule,
    StatsModule,
    SubscriptionsModule,
    PayrollModule,
    PlatformModule,
    LandingModule,
    BrandingModule,
    RealtimeModule,
    JobsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useExisting: SubscriptionGuard },
    // L'audit enveloppe la transaction : il n'écrit qu'une fois la requête terminée.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Annonce des mises à jour aux appareils, après l'enregistrement.
    { provide: APP_INTERCEPTOR, useClass: SyncInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
    { provide: APP_FILTER, useClass: QueryFailedFilter },
  ],
})
export class AppModule {}
