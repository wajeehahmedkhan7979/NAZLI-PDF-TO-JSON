import { Module } from '@nestjs/common';
import { SegmentationService } from './segmentation.service';

@Module({
  providers: [SegmentationService],
  exports: [SegmentationService],
})
export class SegmentationModule {}
