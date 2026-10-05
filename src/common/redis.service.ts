import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis({
      host: config.get<string>('REDIS_HOST'),
      port: Number(config.get('REDIS_PORT') ?? 6379),
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    });
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
