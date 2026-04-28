import { Injectable, Logger } from '@nestjs/common';

/**
 * PipelineMetrics — lightweight in-process metrics collector.
 *
 * Counters and histograms for all pipeline stages.
 * Exposed via /metrics endpoint (JSON, not Prometheus — keeps deps minimal).
 *
 * In production, replace or supplement with Prometheus client if needed.
 */
@Injectable()
export class PipelineMetrics {
  private readonly logger = new Logger(PipelineMetrics.name);

  private readonly counters: Record<string, number> = {};
  private readonly latencies: Record<string, number[]> = {};
  private readonly gauges: Record<string, number> = {};

  // ── Counter API ──────────────────────────────────────────
  increment(metric: string, by = 1): void {
    this.counters[metric] = (this.counters[metric] || 0) + by;
  }

  // ── Gauge API ────────────────────────────────────────────
  setGauge(metric: string, value: number): void {
    this.gauges[metric] = value;
  }

  // ── Latency / Histogram API ──────────────────────────────
  recordLatency(metric: string, ms: number): void {
    if (!this.latencies[metric]) this.latencies[metric] = [];
    const arr = this.latencies[metric];
    arr.push(ms);
    // Cap at 10000 samples per metric to prevent unbounded memory
    if (arr.length > 10_000) arr.shift();
  }

  /** Helper: time an async operation and record its latency */
  async time<T>(metric: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.recordLatency(metric, Date.now() - start);
      return result;
    } catch (err) {
      this.recordLatency(`${metric}.error`, Date.now() - start);
      throw err;
    }
  }

  // ── Snapshot ─────────────────────────────────────────────
  snapshot(): Record<string, any> {
    const snapshot: Record<string, any> = {
      counters: { ...this.counters },
      gauges: { ...this.gauges },
      latencies: {},
    };

    for (const [key, samples] of Object.entries(this.latencies)) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      snapshot.latencies[key] = {
        count: samples.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: parseFloat((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2)),
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)],
      };
    }

    return snapshot;
  }

  // ── Standard pipeline metric names (typed constants) ─────
  static readonly DOCS_PROCESSED = 'docs.processed';
  static readonly DOCS_FAILED = 'docs.failed';
  static readonly DOCS_NEEDS_REVIEW = 'docs.needs_review';
  static readonly EXTRACTION_LATENCY = 'latency.extraction_ms';
  static readonly UNDERSTANDING_LATENCY = 'latency.understanding_ms';
  static readonly SEGMENTATION_LATENCY = 'latency.segmentation_ms';
  static readonly TRANSLATION_LATENCY = 'latency.translation_ms';
  static readonly VALIDATION_LATENCY = 'latency.validation_ms';
  static readonly CACHE_HIT_RATIO = 'cache.hit_ratio';
  static readonly FALLBACK_COUNT = 'extraction.fallback_count';
  static readonly SIDECAR_AVAILABLE = 'sidecar.available';
  static readonly CONFIDENCE_PURCHASE = 'confidence.purchase';
  static readonly CONFIDENCE_BILLING = 'confidence.billing';
  static readonly CONFIDENCE_AUCTION = 'confidence.auction';
  static readonly TRANSLATION_TIER1 = 'translation.tier1_count';
  static readonly TRANSLATION_TIER2 = 'translation.tier2_count';
  static readonly TRANSLATION_TIER3 = 'translation.tier3_count';
  static readonly TRANSLATION_TIER4 = 'translation.tier4_count';
  static readonly TRANSLATION_FAILED = 'translation.failed_count';
}
