import { Injectable } from '@nestjs/common';
import type { DayStatus, LiveAgentPosition } from '@suivi/shared';
import { RedisService } from '../common/redis.service';

export interface LiveEntry extends LiveAgentPosition {
  dayId: string;
  receivedAt: string;
}

/** Dernière position connue de chaque agent en journée, conservée dans Redis. */
@Injectable()
export class LiveService {
  constructor(private readonly redis: RedisService) {}

  private key(tenantId: string) {
    return `live:${tenantId}`;
  }

  async all(tenantId: string): Promise<Map<string, LiveEntry>> {
    const raw = await this.redis.client.hgetall(this.key(tenantId));
    return new Map(
      Object.entries(raw).map(([agentId, json]) => [
        agentId,
        JSON.parse(json) as LiveEntry,
      ]),
    );
  }

  async get(tenantId: string, agentId: string): Promise<LiveEntry | null> {
    const raw = await this.redis.client.hget(this.key(tenantId), agentId);
    return raw ? (JSON.parse(raw) as LiveEntry) : null;
  }

  /** Enregistre la position si elle est plus récente que la précédente. */
  async upsert(tenantId: string, entry: LiveEntry): Promise<boolean> {
    const current = await this.get(tenantId, entry.agentId);
    if (
      current &&
      current.dayId === entry.dayId &&
      current.recordedAt >= entry.recordedAt
    )
      return false;
    await this.redis.client.hset(
      this.key(tenantId),
      entry.agentId,
      JSON.stringify(entry),
    );
    return true;
  }

  async setStatus(
    tenantId: string,
    agentId: string,
    status: DayStatus,
    zoneId?: string | null,
  ) {
    const current = await this.get(tenantId, agentId);
    if (!current) return;
    await this.redis.client.hset(
      this.key(tenantId),
      agentId,
      JSON.stringify({
        ...current,
        status,
        ...(zoneId !== undefined ? { zoneId } : {}),
      }),
    );
  }

  async remove(tenantId: string, agentId: string) {
    await this.redis.client.hdel(this.key(tenantId), agentId);
  }
}
