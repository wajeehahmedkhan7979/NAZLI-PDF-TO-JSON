import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { OrchestratorService } from './orchestrator.service';
import { DocumentPipelineProcessor } from './processors/document-pipeline.processor';
import { ClassifierModule } from '../classifier/classifier.module';
import { AuctionModule } from '../auction/auction.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'document-pipeline' }),
    ClassifierModule,
    AuctionModule,
  ],
  providers: [
    OrchestratorService,
    DocumentPipelineProcessor,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
