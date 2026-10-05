import { Injectable } from '@nestjs/common';
import { DbService } from './common/db.service';
import { RedisService } from './common/redis.service';

@Injectable()
export class AppService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  async health() {
    const [{ postgis }] = await this.db.manager.query<{ postgis: string }[]>(
      'SELECT postgis_lib_version() AS postgis',
    );
    const redis = await this.redis.client.ping();
    return {
      status: 'ok',
      database: 'up',
      postgis,
      redis: redis === 'PONG' ? 'up' : 'down',
    };
  }
}
