import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import { getEnv } from "../config/env.js";
import { createRedisClientWithFallback, MockRedis } from "./redis-mock.js";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public readonly client: Redis;

  constructor() {
    const env = getEnv();
    if (!process.env.REDIS_URL || process.env.REDIS_URL.trim().length === 0) {
      this.logger.warn("[AI Studio] REDIS_URL not configured — using in-memory Redis mock");
      this.client = new MockRedis({
        keyPrefix: env.REDIS_KEY_PREFIX,
      }) as unknown as Redis;
      return;
    }

    this.client = createRedisClientWithFallback(
      () =>
        new Redis(env.REDIS_URL, {
          keyPrefix: env.REDIS_KEY_PREFIX,
          maxRetriesPerRequest: 1,
          connectTimeout: 500,
          retryStrategy: () => null,
          enableReadyCheck: false,
          lazyConnect: true,
        }),
      {
        keyPrefix: env.REDIS_KEY_PREFIX,
        label: "RedisService",
      },
    );
  }

  async ensureConnected(): Promise<void> {
    if (this.client.status === "wait") {
      await this.client.connect();
    }
  }

  async ping(): Promise<"PONG"> {
    await this.ensureConnected();
    return this.client.ping();
  }

  async getJson<T>(key: string): Promise<T | null> {
    await this.ensureConnected();
    const raw = await this.client.get(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as T;
  }

  async setJson<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    await this.ensureConnected();
    const serialized = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await this.client.set(key, serialized, "EX", ttlSeconds);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.ensureConnected();
    await this.client.del(key);
  }

  async invalidateOrganizationCache(
    organizationId: string,
    namespace: string,
  ): Promise<void> {
    await this.del(`org:${organizationId}:${namespace}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status !== "end") {
      await this.client.quit();
    }
  }
}
