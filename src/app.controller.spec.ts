import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { AppController } from './app.controller';
import { AppService, type Sante } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  let sante: Sante;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: { health: () => Promise.resolve(sante) },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  /** Réponse HTTP factice : on regarde seulement le code fixé par le contrôleur. */
  const reponse = () => {
    const status = jest.fn();
    return { res: { status } as unknown as Response, status };
  };

  it('tout répond : 200 et l’état de chaque service', async () => {
    sante = { status: 'ok', database: 'up', postgis: '3.4', redis: 'up' };
    const { res, status } = reponse();
    await expect(appController.health(res)).resolves.toMatchObject({
      status: 'ok',
    });
    expect(status).not.toHaveBeenCalled();
  });

  it('un service en panne : 503 pour la surveillance', async () => {
    sante = { status: 'down', database: 'up', postgis: '3.4', redis: 'down' };
    const { res, status } = reponse();
    await expect(appController.health(res)).resolves.toMatchObject({
      redis: 'down',
    });
    expect(status).toHaveBeenCalledWith(503);
  });
});
