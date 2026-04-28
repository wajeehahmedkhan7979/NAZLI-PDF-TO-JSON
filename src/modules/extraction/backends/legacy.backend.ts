import { Injectable, Logger } from '@nestjs/common';
import {
  ExtractionBackend,
  ExtractionBlock,
  ExtractionOptions,
  ExtractionPageMeta,
  ExtractionResult,
} from '../interfaces/extraction-backend.interface';
import { PdfTextExtractor, ExtractionResultBlock } from '../extractors/pdf-text.extractor';
import { OcrExtractor } from '../extractors/ocr.extractor';
import { TableExtractor } from '../extractors/table.extractor';
import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * LegacyBackend — ExtractionBackend implementation using the built-in
 * pdf-parse + tesseract.js extractors.
 *
 * Used as a fallback when the Marker sidecar is unavailable.
 * Produces lower-quality output (no layout analysis, no block tree).
 */
@Injectable()
export class LegacyBackend implements ExtractionBackend {
  private readonly logger = new Logger(LegacyBackend.name);

  constructor(
    private pdfExtractor: PdfTextExtractor,
    private ocrExtractor: OcrExtractor,
    private tableExtractor: TableExtractor,
  ) {}

  async extract(filePath: string, options: ExtractionOptions): Promise<ExtractionResult> {
    const startMs = Date.now();

    this.logger.log('Using legacy extraction backend (pdf-parse + tesseract.js)');

    // Compute file hash
    const fileBuffer = await fs.promises.readFile(filePath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Extract raw blocks
    let rawBlocks: ExtractionResultBlock[];
    let extractionMethod: 'pdftext' | 'ocr' = 'pdftext';

    if (options.forceOcr) {
      rawBlocks = await this.ocrExtractor.extract([filePath]);
      extractionMethod = 'ocr';
    } else {
      rawBlocks = await this.pdfExtractor.extract(filePath);

      // If text extraction returned very little, try OCR
      const totalText = rawBlocks.reduce((acc, b) => acc + (b.text || '').length, 0);
      if (totalText < 50) {
        this.logger.warn('Text extraction returned too little content, attempting OCR...');
        try {
          rawBlocks = await this.ocrExtractor.extract([filePath]);
          extractionMethod = 'ocr';
        } catch (err: any) {
          this.logger.error(`OCR fallback failed: ${err.message}`);
          // Keep whatever we got from pdf-parse
        }
      }
    }

    // Apply table detection
    const structuredBlocks = this.tableExtractor.extractTablesFromBlocks(rawBlocks);

    // Transform to ExtractionBlock format
    const blocks: ExtractionBlock[] = structuredBlocks.map((block, idx) => {
      // Convert ExtractionBox {x, y, width, height} → number[] [x1, y1, x2, y2]
      let bbox: number[] | undefined;
      if (block.bbox) {
        bbox = [
          block.bbox.x,
          block.bbox.y,
          block.bbox.x + block.bbox.width,
          block.bbox.y + block.bbox.height,
        ];
      }
      return {
        blockId: `legacy_${idx}`,
        blockType: this.mapBlockType(block.type),
        page: block.page,
        position: idx,
        text: block.text,
        polygon: undefined,
        bbox,
        confidence: block.confidence,
        status: 'ok' as const,
      };
    });

    // Build page meta
    const pageSet = new Set(blocks.map((b) => b.page));
    const pageMeta: ExtractionPageMeta[] = Array.from(pageSet)
      .sort()
      .map((pageIdx) => {
        const pageBlocks = blocks.filter((b) => b.page === pageIdx);
        return {
          pageIndex: pageIdx,
          textExtractionMethod: extractionMethod,
          blockCount: pageBlocks.length,
          ocrConfidence:
            pageBlocks.reduce((acc, b) => acc + b.confidence, 0) / (pageBlocks.length || 1),
        };
      });

    const elapsedMs = Date.now() - startMs;

    return {
      blocks,
      pageMeta,
      pageCount: pageSet.size,
      fileHash,
      engine: 'legacy-pdfparse',
      engineVersion: '1.0.0',
      elapsedMs,
      forceOcr: options.forceOcr || false,
      usedLlm: false,
    };
  }

  async isAvailable(): Promise<boolean> {
    // Legacy backend is always available
    return true;
  }

  engineName(): string {
    return 'legacy-pdfparse';
  }

  engineVersion(): string {
    return '1.0.0';
  }

  private mapBlockType(type: string): string {
    switch (type) {
      case 'text':
        return 'Text';
      case 'table_row':
        return 'Table';
      case 'header':
        return 'SectionHeader';
      default:
        return 'Text';
    }
  }
}
