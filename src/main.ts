import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { initMonitoring } from './common/monitoring';

async function bootstrap() {
  initMonitoring();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Derrière un proxy (Nginx, Traefik) : vraie adresse du client pour le journal,
  // la liste blanche et le verrouillage de la connexion éditeur (ex. TRUST_PROXY=1).
  if (process.env.TRUST_PROXY)
    app.set(
      'trust proxy',
      Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY,
    );

  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Suivi Agent API')
    .setDescription(
      "API de la plateforme de suivi des agents terrain. Connectez-vous avec POST /api/auth/login, puis cliquez sur « Authorize » et collez l'accessToken.",
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
    {
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'none',
        tagsSorter: 'alpha',
      },
    },
  );

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
