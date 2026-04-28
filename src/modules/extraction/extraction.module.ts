import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExtractionService } from './extraction.service';
import { PdfTextExtractor } from './extractors/pdf-text.extractor';
import { OcrExtractor } from './extractors/ocr.extractor';
import { TableExtractor } from './extractors/table.extractor';
import { MarkerClient } from './clients/marker.client';
import { MarkerBackend } from './backends/marker.backend';
import { LegacyBackend } from './backends/legacy.backend';

@Module({
  imports: [ConfigModule],
  providers: [
    // Extraction backends
    MarkerClient,
    MarkerBackend,
    LegacyBackend,
    // Legacy extractors (used by LegacyBackend)
    PdfTextExtractor,
    OcrExtractor,
    TableExtractor,
    // Main service
    ExtractionService,
  ],
  exports: [ExtractionService, MarkerClient],
})
export class ExtractionModule {}
