import { Module, Global } from '@nestjs/common';
import { PipelineCacheService } from './pipeline-cache.service';

/**
 * CacheModule — global module providing PipelineCacheService.
 * Connects to Redis on init, fails open if unavailable.
 */
@Global()
@Module({
  providers: [PipelineCacheService],
  exports: [PipelineCacheService],
})
export class CacheModule {}
