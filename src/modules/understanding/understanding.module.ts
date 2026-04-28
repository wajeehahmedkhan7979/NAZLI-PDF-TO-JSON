import { Module } from '@nestjs/common';
import { UnderstandingService } from './understanding.service';
import { BlockNormalizer } from './processors/block-normalizer';
import { TableReconstructor } from './processors/table-reconstructor';
import { KeyValueDetector } from './processors/key-value-detector';
import { SectionClassifier } from './processors/section-classifier';
import { FieldCandidateBuilder } from './processors/field-candidate-builder';

@Module({
  providers: [
    UnderstandingService,
    BlockNormalizer,
    TableReconstructor,
    KeyValueDetector,
    SectionClassifier,
    FieldCandidateBuilder,
  ],
  exports: [UnderstandingService],
})
export class UnderstandingModule {}
