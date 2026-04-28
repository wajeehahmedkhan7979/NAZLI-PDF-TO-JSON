import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * PipelineCacheService — Redis-backed cache for extraction, translation, and segmentation.
 *
 * Cache keys are version-scoped so previous data is automatically invalidated
 * when engine versions change — no manual cache busting needed.
 *
 * Key format:
 *   nazli:extraction:v{engineVersion}:{fileHash}
 *   nazli:translation:v{glossaryVersion}:{providerVersion}:{textHash}
 *   nazli:segmentation:v{segVersion}:{extractionHash}
 *
 * Fails open on all Redis errors — never blocks the pipeline on cache issues.
 */
@Injectable()
export class PipelineCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipelineCacheService.name);
  private redis: Redis | null = null;

  // TTLs (seconds) — configurable via environment variables
  private readonly TTL = {
    extraction: parseInt(process.env.CACHE_TTL_EXTRACTION_S || '86400', 10),    // 24h
    translation: parseInt(process.env.CACHE_TTL_TRANSLATION_S || '604800', 10), // 7d
    segmentation: parseInt(process.env.CACHE_TTL_SEGMENTATION_S || '86400', 10), // 24h
  };

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    try {
      const host = this.config.get<string>('redis.host') || 'localhost';
      const port = this.config.get<number>('redis.port') || 6379;
      this.redis = new Redis({ host, port, maxRetriesPerRequest: 1, lazyConnect: true });
      await this.redis.connect();
      this.logger.log(`Cache connected to Redis at ${host}:${port}`);
    } catch (err: any) {
      this.logger.warn(`Cache failed to connect to Redis: ${err.message}. Caching disabled.`);
      this.redis = null;
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit().catch(() => {});
    }
  }

  // ── Extraction ───────────────────────────────────────────

  extractionKey(fileHash: string, engineVersion: string): string {
    return `nazli:extraction:v${engineVersion}:${fileHash}`;
  }

  async getExtraction(fileHash: string, engineVersion: string): Promise<any | null> {
    return this.get(this.extractionKey(fileHash, engineVersion), 'extraction');
  }

  async setExtraction(fileHash: string, engineVersion: string, data: any): Promise<void> {
    await this.set(this.extractionKey(fileHash, engineVersion), data, this.TTL.extraction, 'extraction');
  }

  // ── Translation ──────────────────────────────────────────

  translationKey(textHash: string, glossaryVersion: string, providerVersion: string): string {
    return `nazli:translation:v${glossaryVersion}:${providerVersion}:${textHash}`;
  }

  async getTranslation(
    textHash: string,
    glossaryVersion: string,
    providerVersion: string,
  ): Promise<{ translated: string; confidence: number; tier: number } | null> {
    return this.get(
      this.translationKey(textHash, glossaryVersion, providerVersion),
      'translation',
    );
  }

  async setTranslation(
    textHash: string,
    glossaryVersion: string,
    providerVersion: string,
    data: { translated: string; confidence: number; tier: number },
  ): Promise<void> {
    await this.set(
      this.translationKey(textHash, glossaryVersion, providerVersion),
      data,
      this.TTL.translation,
      'translation',
    );
  }

  // ── Segmentation ─────────────────────────────────────────

  segmentationKey(extractionHash: string, segVersion: string): string {
    return `nazli:segmentation:v${segVersion}:${extractionHash}`;
  }

  async getSegmentation(extractionHash: string, segVersion: string): Promise<any | null> {
    return this.get(this.segmentationKey(extractionHash, segVersion), 'segmentation');
  }

  async setSegmentation(extractionHash: string, segVersion: string, data: any): Promise<void> {
    await this.set(this.segmentationKey(extractionHash, segVersion), data, this.TTL.segmentation, 'segmentation');
  }

  // ── Cache stats ──────────────────────────────────────────

  private hitCount = 0;
  private missCount = 0;

  getHitRatio(): number {
    const total = this.hitCount + this.missCount;
    return total > 0 ? this.hitCount / total : 0;
  }

  getStats() {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      hitRatio: parseFloat(this.getHitRatio().toFixed(3)),
      connected: this.redis !== null,
    };
  }

  // ── Internal helpers ─────────────────────────────────────

  private async get(key: string, type: string): Promise<any | null> {
    if (!this.redis) {
      this.missCount++;
      return null;
    }
    try {
      const raw = await this.redis.get(key);
      if (raw) {
        this.hitCount++;
        this.logger.debug(`Cache HIT [${type}]: ${key}`);
        return JSON.parse(raw);
      }
      this.missCount++;
      this.logger.debug(`Cache MISS [${type}]: ${key}`);
      return null;
    } catch (err: any) {
      this.logger.warn(`Cache GET failed for ${key}: ${err.message}`);
      this.missCount++;
      return null; // Fail open — never block on cache error
    }
  }

  private async set(key: string, data: any, ttlSeconds: number, type: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
      this.logger.debug(`Cache SET [${type}]: ${key} (TTL: ${ttlSeconds}s)`);
    } catch (err: any) {
      this.logger.warn(`Cache SET failed for ${key}: ${err.message}`);
      // Fail open — continue without caching
    }
  }
}
