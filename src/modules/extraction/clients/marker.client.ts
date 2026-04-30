import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { CircuitBreaker, CircuitOpenError } from '../../../common/resilience/circuit-breaker';

/**
 * MarkerClient — HTTP client for the Marker Python sidecar.
 *
 * Features:
 * - Circuit breaker to prevent cascade failures
 * - Health-check-driven availability cache (avoids hammering dead sidecar)
 * - Per-request timeout enforcement
 * - Exponential backoff retries
 * - Structured error classification
 */

export interface MarkerConvertOptions {
  forceOcr?: boolean;
  useLlm?: boolean;
  pageRange?: string;
}

export interface MarkerConvertResponse {
  file_hash: string;
  filename: string;
  engine: string;
  engine_version: string;
  force_ocr: boolean;
  use_llm: boolean;
  elapsed_ms: number;
  pages: any[];
  metadata: any;
}

export interface MarkerTableResponse {
  engine: string;
  elapsed_ms: number;
  tables: any[];
}

export type MarkerErrorType =
  | 'unavailable'
  | 'timeout'
  | 'circuit_open'
  | 'invalid_response'
  | 'empty_extraction'
  | 'low_confidence'
  | 'unknown'
  | 'capacity_reached'
  | 'file_too_large';

export class MarkerError extends Error {
  constructor(
    public readonly errorType: MarkerErrorType,
    message: string,
  ) {
    super(message);
    this.name = 'MarkerError';
  }
}

@Injectable()
export class MarkerClient {
  private readonly logger = new Logger(MarkerClient.name);
  private readonly baseUrls: string[];
  private currentUrlIndex = 0;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly circuitBreaker: CircuitBreaker;

  // Health-check cache to avoid hammering dead sidecar
  private lastHealthCheck: { available: boolean; checkedAt: number } = {
    available: false,
    checkedAt: 0,
  };
  private readonly healthCacheTtlMs = 10_000; // cache health for 10s

  // Concurrency and Size limits
  private activeRequests = 0;
  private readonly maxConcurrentRequests = 4;
  private readonly maxFileSize = 20 * 1024 * 1024; // 20 MB

  constructor(private config: ConfigService) {
    const urlConfig = this.config.get<string>('marker.url') || this.config.get<string>('MARKER_SIDECAR_URL', 'http://localhost:8001');
    this.baseUrls = urlConfig.split(',').map(u => u.trim()).filter(u => u.length > 0);
    if (this.baseUrls.length === 0) {
      this.baseUrls.push('http://localhost:8001');
    }

    this.timeoutMs = this.config.get<number>('marker.timeoutMs') || this.config.get<number>('MARKER_TIMEOUT_MS', 120000);
    this.maxRetries = this.config.get<number>('marker.maxRetries') || this.config.get<number>('MARKER_MAX_RETRIES', 2);

    const cbThreshold = this.config.get<number>('marker.circuitBreaker.failureThreshold') || 5;
    const cbRecovery = this.config.get<number>('marker.circuitBreaker.recoveryTimeMs') || 30_000;

    this.circuitBreaker = new CircuitBreaker({
      name: 'marker-sidecar',
      failureThreshold: cbThreshold,
      recoveryTimeMs: cbRecovery,
      requestTimeoutMs: this.timeoutMs,
    });
  }

  /**
   * Get the next available Marker URL using round-robin.
   */
  private getNextUrl(): string {
    const url = this.baseUrls[this.currentUrlIndex];
    this.currentUrlIndex = (this.currentUrlIndex + 1) % this.baseUrls.length;
    return url;
  }

  /**
   * Convert a PDF to Marker's JSON block tree.
   * Returns null on failure (caller should fallback to legacy).
   * Throws MarkerError with classification for observability.
   */
  async convertPdf(
    filePath: string,
    options: MarkerConvertOptions = {},
  ): Promise<MarkerConvertResponse | null> {
    if (this.activeRequests >= this.maxConcurrentRequests) {
      this.logger.warn(`Marker capacity reached (${this.activeRequests}/${this.maxConcurrentRequests})`);
      // Fail fast to allow fallback or retry later
      return null;
    }

    return this.withRetry(async () => {
      return this.circuitBreaker.execute(async () => {
        this.activeRequests++;
        try {
          const formData = await this.buildFormData(filePath, options);
          const url = `${this.getNextUrl()}/convert`;

          this.logger.debug(`POST ${url} (file: ${path.basename(filePath)})`);

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

          try {
            const response = await fetch(url, {
              method: 'POST',
              body: formData,
              signal: controller.signal,
            });

            if (!response.ok) {
              const errorText = await response.text();
              this.logger.error(`Marker returned ${response.status}: ${errorText}`);
              throw new MarkerError('invalid_response', `Marker HTTP ${response.status}: ${errorText}`);
            }

            return (await response.json()) as MarkerConvertResponse;
          } catch (err: any) {
            if (err instanceof MarkerError) throw err;
            if (err.name === 'AbortError') {
              throw new MarkerError('timeout', `Marker request timed out (${this.timeoutMs}ms)`);
            }
            throw new MarkerError('unavailable', `Marker unreachable: ${err.message}`);
          } finally {
            clearTimeout(timeout);
          }
        } finally {
          this.activeRequests--;
        }
      });
    });
  }

  /**
   * Extract only tables from a PDF.
   */
  async convertTables(
    filePath: string,
    options: { forceOcr?: boolean; useLlm?: boolean } = {},
  ): Promise<MarkerTableResponse | null> {
    if (this.activeRequests >= this.maxConcurrentRequests) {
      this.logger.warn(`Marker tables capacity reached (${this.activeRequests}/${this.maxConcurrentRequests})`);
      return null;
    }

    return this.withRetry(async () => {
      return this.circuitBreaker.execute(async () => {
        this.activeRequests++;
        try {
          const formData = await this.buildFormData(filePath, options);
          const url = `${this.getNextUrl()}/convert/tables`;

          this.logger.debug(`POST ${url} (tables only)`);

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

          try {
            const response = await fetch(url, {
              method: 'POST',
              body: formData,
              signal: controller.signal,
            });

            if (!response.ok) {
              throw new MarkerError('invalid_response', `Tables endpoint returned ${response.status}`);
            }
            return (await response.json()) as MarkerTableResponse;
          } catch (err: any) {
            if (err instanceof MarkerError) throw err;
            if (err.name === 'AbortError') {
              throw new MarkerError('timeout', `Tables request timed out`);
            }
            throw new MarkerError('unavailable', `Tables endpoint unreachable: ${err.message}`);
          } finally {
            clearTimeout(timeout);
          }
        } finally {
          this.activeRequests--;
        }
      });
    });
  }

  /**
   * Check if the Marker sidecar is reachable.
   * Uses a cached result for healthCacheTtlMs to avoid hammering.
   */
  async healthCheck(): Promise<{ available: boolean; modelsLoaded?: boolean; version?: string }> {
    // Return cached result if fresh
    const now = Date.now();
    if (now - this.lastHealthCheck.checkedAt < this.healthCacheTtlMs) {
      return { available: this.lastHealthCheck.available };
    }

    // Circuit breaker check first — no point hitting a known-dead service
    if (!this.circuitBreaker.isAvailable()) {
      this.lastHealthCheck = { available: false, checkedAt: now };
      return { available: false };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        // Just ping the next URL to check cluster health
        const url = `${this.getNextUrl()}/health`;
        const response = await fetch(url, {
          signal: controller.signal,
        });

        if (!response.ok) {
          this.lastHealthCheck = { available: false, checkedAt: now };
          return { available: false };
        }

        const data = await response.json();
        this.lastHealthCheck = { available: true, checkedAt: now };
        return {
          available: true,
          modelsLoaded: data.models_loaded,
          version: data.engine_version,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      this.lastHealthCheck = { available: false, checkedAt: now };
      return { available: false };
    }
  }

  /** Expose circuit breaker state for metrics/observability */
  getCircuitState() {
    return this.circuitBreaker.getState();
  }

  // ── Private helpers ────────────────────────────────────────

  private async buildFormData(
    filePath: string,
    options: MarkerConvertOptions,
  ): Promise<FormData> {
    const stats = await fs.promises.stat(filePath);
    if (stats.size > this.maxFileSize) {
      throw new MarkerError('file_too_large', `File size ${stats.size} exceeds maximum ${this.maxFileSize}`);
    }

    const fileBuffer = await fs.promises.readFile(filePath);
    const blob = new Blob([fileBuffer], { type: 'application/pdf' });
    const filename = path.basename(filePath);

    const formData = new FormData();
    formData.append('file', blob, filename);

    if (options.forceOcr) {
      formData.append('force_ocr', 'true');
    }
    if (options.useLlm) {
      formData.append('use_llm', 'true');
    }
    if (options.pageRange) {
      formData.append('page_range', options.pageRange);
    }

    return formData;
  }

  /**
   * Retry with exponential backoff. Returns null on all failures.
   */
  private async withRetry<T>(fn: () => Promise<T | null>): Promise<T | null> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await fn();
        if (result !== null) return result;

        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          this.logger.warn(`Marker attempt ${attempt + 1} returned null, retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      } catch (err: any) {
        // Circuit breaker open — fail immediately, no retries
        if (err instanceof CircuitOpenError) {
          this.logger.warn(`Circuit breaker open: ${err.message}`);
          return null;
        }

        const errorType = err instanceof MarkerError ? err.errorType : 'unknown';
        this.logger.error(`Marker error [${errorType}]: ${err.message}`);

        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          this.logger.warn(`Retrying in ${delay}ms (attempt ${attempt + 2}/${this.maxRetries + 1})`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    this.logger.error('All Marker attempts exhausted. Returning null for fallback.');
    return null;
  }
}
