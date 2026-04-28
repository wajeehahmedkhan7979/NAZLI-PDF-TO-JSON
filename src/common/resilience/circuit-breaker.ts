import { Injectable, Logger } from '@nestjs/common';

/**
 * CircuitBreaker — prevents cascade failures when a downstream service is unhealthy.
 *
 * States:
 *   CLOSED   → normal, requests pass through
 *   OPEN     → service is down, requests fail immediately (no hammering)
 *   HALF_OPEN → probe: one test request allowed to check recovery
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Failures before opening (default: 5) */
  failureThreshold: number;
  /** Milliseconds to wait before half-open probe (default: 30000) */
  recoveryTimeMs: number;
  /** Milliseconds each request is allowed to run (default: 30000) */
  requestTimeoutMs: number;
  /** Name for logging */
  name: string;
}

@Injectable()
export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);

  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly options: CircuitBreakerOptions;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      recoveryTimeMs: options.recoveryTimeMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      name: options.name ?? 'unnamed',
    };
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CircuitOpenError if circuit is OPEN.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.guardOpen();

    try {
      const result = await this.withTimeout(fn, this.options.requestTimeoutMs);
      this.onSuccess();
      return result;
    } catch (err: any) {
      this.onFailure(err);
      throw err;
    }
  }

  getState(): CircuitState {
    this.tryTransition();
    return this.state;
  }

  isAvailable(): boolean {
    this.tryTransition();
    return this.state !== 'OPEN';
  }

  /** Force reset — used in tests or manual recovery */
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.logger.log(`[${this.options.name}] Circuit manually reset`);
  }

  /**
   * Non-throwing transition check: OPEN → HALF_OPEN if recovery time elapsed.
   * Used by getState() and isAvailable().
   */
  private tryTransition(): void {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.options.recoveryTimeMs) {
        this.state = 'HALF_OPEN';
        this.logger.log(`[${this.options.name}] Circuit → HALF_OPEN (probing)`);
      }
    }
  }

  /**
   * Throwing guard: blocks execution if circuit is OPEN.
   * Used by execute().
   */
  private guardOpen(): void {
    this.tryTransition();
    if (this.state === 'OPEN') {
      throw new CircuitOpenError(
        this.options.name,
        this.options.recoveryTimeMs - (Date.now() - this.lastFailureTime),
      );
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.logger.log(`[${this.options.name}] Circuit → CLOSED (recovered)`);
    }
    this.state = 'CLOSED';
    this.failureCount = 0;
  }

  private onFailure(err: any): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.logger.warn(`[${this.options.name}] Probe failed → Circuit OPEN again`);
      return;
    }

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.logger.error(
        `[${this.options.name}] Circuit OPENED after ${this.failureCount} failures. ` +
          `Recovery in ${this.options.recoveryTimeMs}ms. Last error: ${err?.message}`,
      );
    } else {
      this.logger.warn(
        `[${this.options.name}] Failure ${this.failureCount}/${this.options.failureThreshold}: ${err?.message}`,
      );
    }
  }

  private withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Circuit breaker timeout after ${ms}ms`)),
        ms,
      );
      fn()
        .then((r) => { clearTimeout(timer); resolve(r); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }
}

export class CircuitOpenError extends Error {
  constructor(name: string, retryAfterMs: number) {
    super(`Circuit breaker OPEN for "${name}". Retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}
