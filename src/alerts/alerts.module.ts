import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller';

/** Centre d'alertes des responsables (la détection est dans AlertsService, commun). */
@Module({ controllers: [AlertsController] })
export class AlertsModule {}
