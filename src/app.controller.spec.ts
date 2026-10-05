import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: {
            health: () =>
              Promise.resolve({ status: 'ok', database: 'up', postgis: '3.4' }),
          },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  it('returns the health status', async () => {
    await expect(appController.health()).resolves.toMatchObject({
      status: 'ok',
    });
  });
});
