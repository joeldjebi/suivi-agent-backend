import { Injectable } from '@nestjs/common';
import { DbService } from './common/db.service';
import { RedisService } from './common/redis.service';

/** Délai de réponse au-delà duquel un service est considéré comme en panne. */
const DELAI_MS = 3000;

const avecDelai = <T>(promesse: Promise<T>) =>
  Promise.race([
    promesse,
    new Promise<never>((_, refuse) =>
      setTimeout(() => refuse(new Error('délai dépassé')), DELAI_MS),
    ),
  ]);

export interface Sante {
  status: 'ok' | 'down';
  database: 'up' | 'down';
  postgis: string | null;
  redis: 'up' | 'down';
}

@Injectable()
export class AppService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  /**
   * État de l'API, de la base (PostGIS) et de Redis. Une panne de l'un d'eux donne
   * `status: 'down'` : la route répond alors 503, ce que voit la surveillance (UptimeRobot).
   */
  async health(): Promise<Sante> {
    const [base, redis] = await Promise.allSettled([
      avecDelai(
        this.db.manager.query<{ postgis: string }[]>(
          'SELECT postgis_lib_version() AS postgis',
        ),
      ),
      avecDelai(this.redis.client.ping()),
    ]);
    const database = base.status === 'fulfilled' ? 'up' : 'down';
    const redisUp = redis.status === 'fulfilled' && redis.value === 'PONG';
    return {
      status: database === 'up' && redisUp ? 'ok' : 'down',
      database,
      postgis: base.status === 'fulfilled' ? base.value[0].postgis : null,
      redis: redisUp ? 'up' : 'down',
    };
  }
}
