import { Module, Global } from '@nestjs/common';
import { PipelineMetrics } from '../../common/metrics/pipeline-metrics';
import { MetricsController } from './metrics.controller';

/**
 * MetricsModule — global module providing PipelineMetrics singleton.
 * Import once in AppModule, inject PipelineMetrics in any service.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [PipelineMetrics],
  exports: [PipelineMetrics],
})
export class MetricsModule {}
