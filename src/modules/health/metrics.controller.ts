import { Controller, Get } from '@nestjs/common';
import { PipelineMetrics } from '../../common/metrics/pipeline-metrics';

/**
 * MetricsController — exposes pipeline metrics as JSON.
 *
 * GET /metrics → full metrics snapshot (counters, gauges, latency histograms)
 *
 * In production, supplement with Prometheus export if needed.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: PipelineMetrics) {}

  @Get()
  getMetrics() {
    return this.metrics.snapshot();
  }
}
