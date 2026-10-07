import { Module } from '@nestjs/common';
import { AlertsController, SafetyController } from './alerts.controller';

/** Centre d'alertes des responsables (la détection est dans AlertsService, commun). */
@Module({ controllers: [AlertsController, SafetyController] })
export class AlertsModule {}
