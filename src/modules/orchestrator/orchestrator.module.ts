import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { OrchestratorService } from './orchestrator.service';
import { DocumentPipelineProcessor } from './processors/document-pipeline.processor';
import { ClassifierModule } from '../classifier/classifier.module';
import { ExtractionModule } from '../extraction/extraction.module';
import { UnderstandingModule } from '../understanding/understanding.module';
import { SegmentationModule } from '../segmentation/segmentation.module';
import { NormalizationModule } from '../normalization/normalization.module';
import { TranslationModule } from '../translation/translation.module';
import { ValidationModule } from '../validation/validation.module';
import { SchemaMapperModule } from '../schema-mapper/schema-mapper.module';
import { ConfidenceCalculator } from '../validation/confidence-calculator';
import { PurchaseValidator } from '../validation/validators/purchase.validator';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'document-pipeline' }),
    ClassifierModule,
    ExtractionModule,
    UnderstandingModule,
    SegmentationModule,
    NormalizationModule,
    TranslationModule,
    ValidationModule,
    SchemaMapperModule,
  ],
  providers: [
    OrchestratorService,
    DocumentPipelineProcessor,
    ConfidenceCalculator,
    PurchaseValidator,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
