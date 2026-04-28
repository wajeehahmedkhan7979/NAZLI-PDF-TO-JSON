import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MarkerBackend } from './backends/marker.backend';
import { LegacyBackend } from './backends/legacy.backend';
import {
  ExtractionBackend,
  ExtractionOptions,
  ExtractionResult,
} from './interfaces/extraction-backend.interface';

const prisma = new PrismaClient();

/**
 * ExtractionService — orchestrates PDF extraction with pluggable backends.
 *
 * Strategy: try Marker backend first → fall back to legacy backend.
 * Stores extraction results with engine version for pipeline versioning.
 *
 * Granular Marker failure handling:
 * - Sidecar unavailable → use legacy
 * - Empty blocks from Marker → use legacy
 * - Low OCR confidence → flag as degraded, keep result
 * - Missing tables → call /convert/tables as supplement
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  private readonly backends: ExtractionBackend[];

  constructor(
    private markerBackend: MarkerBackend,
    private legacyBackend: LegacyBackend,
  ) {
    // Priority order: Marker first, legacy fallback
    this.backends = [this.markerBackend, this.legacyBackend];
  }

  /**
   * Extract structured data from a document using the best available backend.
   */
  async extractStructuredData(documentId: string): Promise<ExtractionResult> {
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new Error(`Document ${documentId} not found`);

    const options: ExtractionOptions = {
      forceOcr: document.isScanned || false,
    };

    let result: ExtractionResult | null = null;
    let usedBackend: string = 'none';

    // ── Try backends in priority order ────────────────────────
    for (const backend of this.backends) {
      const name = backend.engineName();

      try {
        const available = await backend.isAvailable();
        if (!available) {
          this.logger.warn(`Backend ${name} is not available, trying next...`);
          continue;
        }

        this.logger.log(`Attempting extraction with ${name}...`);
        result = await backend.extract(document.storagePath, options);
        usedBackend = name;

        // ── Granular failure detection ─────────────────────
        if (result.blocks.length === 0) {
          this.logger.warn(`Backend ${name} returned 0 blocks. Trying next backend...`);
          result = null;
          continue;
        }

        // Multi-factor extraction confidence (not just naive block avg)
        const extractionConf = this.computeExtractionConfidence(result);
        this.logger.debug(
          `Extraction confidence for ${name}: ` +
          `textDensity=${extractionConf.textDensity.toFixed(3)}, ` +
          `blockConsistency=${extractionConf.blockConsistency.toFixed(3)}, ` +
          `identifierPresence=${extractionConf.identifierPresence.toFixed(3)}, ` +
          `languageMatch=${extractionConf.languageMatch.toFixed(3)}, ` +
          `overall=${extractionConf.overall.toFixed(3)}`,
        );

        if (extractionConf.overall < 0.3 && name === 'marker-pdf') {
          this.logger.warn(
            `Marker returned very low multi-factor confidence (${extractionConf.overall.toFixed(3)}). Trying legacy...`,
          );
          const fallbackResult = result;
          const fallbackConf = extractionConf.overall;
          try {
            result = await this.legacyBackend.extract(document.storagePath, options);
            usedBackend = this.legacyBackend.engineName();
            const legacyConf = this.computeExtractionConfidence(result).overall;
            if (legacyConf <= fallbackConf) {
              this.logger.warn('Legacy also had low confidence. Keeping Marker result.');
              result = fallbackResult;
              usedBackend = name;
            }
          } catch {
            result = fallbackResult;
            usedBackend = name;
          }
        }

        this.logger.log(
          `Extraction via ${usedBackend}: ${result.blocks.length} blocks, ` +
            `${result.pageCount} pages, ${result.elapsedMs}ms`,
        );
        break;
      } catch (err: any) {
        this.logger.error(`Backend ${name} failed: ${err.message}`);
        result = null;
        continue;
      }
    }

    if (!result) {
      throw new Error(
        `All extraction backends failed for document ${documentId}. ` +
          `Tried: ${this.backends.map((b) => b.engineName()).join(', ')}`,
      );
    }

    // ── Persist extraction results ────────────────────────────
    await this.persistExtraction(documentId, result, usedBackend);

    return result;
  }

  /**
   * Persist extraction results to the database.
   */
  private async persistExtraction(
    documentId: string,
    result: ExtractionResult,
    backendName: string,
  ): Promise<void> {
    // Save individual blocks as Extraction records
    for (const block of result.blocks) {
      // Skip container blocks that only have children
      if (!block.text && block.children && block.children.length > 0) continue;

      await prisma.extraction.create({
        data: {
          documentId,
          page: block.page,
          extractionType: block.blockType,
          content: block.text,
          confidence: block.confidence,
          bbox: block.bbox ? (block.bbox as any) : null,
          metadata: {
            blockId: block.blockId,
            position: block.position,
            polygon: block.polygon,
            status: block.status,
            error: block.error,
          } as any,
        },
      });
    }

    // Multi-factor extraction confidence (not naive block average)
    const overallConfidence = this.computeExtractionConfidence(result).overall;

    // Update document with extraction results
    await prisma.document.update({
      where: { id: documentId },
      data: {
        rawExtraction: {
          blocks: result.blocks,
          pageMeta: result.pageMeta,
          pageCount: result.pageCount,
          engine: backendName,
          engineVersion: result.engineVersion,
          elapsedMs: result.elapsedMs,
          forceOcr: result.forceOcr,
          usedLlm: result.usedLlm,
        } as any,
        overallConfidence,
        stage: 'EXTRACTED',
      },
    });

    this.logger.log(
      `Extraction persisted for ${documentId}: ${result.blocks.length} blocks, ` +
        `engine=${backendName}@${result.engineVersion}, confidence=${overallConfidence.toFixed(3)}`,
    );
  }

  // ── Multi-factor extraction confidence ──────────────────
  //
  // Fixes the problem where dense garbage OCR produces high avgConfidence
  // and sparse clean text produces low avgConfidence.
  //
  // Factors:
  //   textDensity:        chars per block (0 = empty blocks, 1 = rich text)
  //   blockConsistency:   layout stability (uniform block sizes)
  //   identifierPresence: VIN, totals, invoice numbers detected
  //   languageMatch:      Japanese character ratio (expected for JP docs)

  private computeExtractionConfidence(result: ExtractionResult): {
    textDensity: number;
    blockConsistency: number;
    identifierPresence: number;
    languageMatch: number;
    overall: number;
  } {
    const blocks = result.blocks.filter((b) => b.text && b.text.length > 0);
    if (blocks.length === 0) {
      return { textDensity: 0, blockConsistency: 0, identifierPresence: 0, languageMatch: 0, overall: 0 };
    }

    // 1. Text density: chars per block, normalized
    const totalChars = blocks.reduce((s, b) => s + b.text.length, 0);
    const avgCharsPerBlock = totalChars / blocks.length;
    // Target: 10-200 chars per block is healthy
    const textDensity = Math.min(1, Math.max(0, avgCharsPerBlock / 100));

    // 2. Block consistency: stddev of block lengths (low = consistent = good)
    const lengths = blocks.map((b) => b.text.length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, l) => a + Math.pow(l - mean, 2), 0) / lengths.length;
    const stddev = Math.sqrt(variance);
    const cv = mean > 0 ? stddev / mean : 1; // coefficient of variation
    const blockConsistency = Math.max(0, 1 - cv / 3); // cv of 3+ = 0 consistency

    // 3. Identifier presence: VIN, chassis, dates, amounts, invoice numbers
    const allText = blocks.map((b) => b.text).join(' ');
    const identifierPatterns = [
      /[A-HJ-NPR-Z0-9]{17}/,                    // VIN
      /[A-Z][A-Z0-9]{2,}-\d{4,}/,               // Chassis
      /\d{4}[-/]\d{1,2}[-/]\d{1,2}/,            // ISO date
      /(令和|平成|昭和)\d+年/,                     // Era date
      /[¥￥][\d,]{3,}/,                           // Currency
      /請求書|納品書|見積書|注文書/,                // Document keywords
    ];
    const foundCount = identifierPatterns.filter((p) => p.test(allText)).length;
    const identifierPresence = Math.min(1, foundCount / 3); // 3+ matches = 1.0

    // 4. Language match: ratio of Japanese chars
    const jpChars = (allText.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g) || []).length;
    const languageMatch = totalChars > 0 ? Math.min(1, jpChars / (totalChars * 0.3)) : 0;
    // 30%+ Japanese chars in a JP doc = full score

    // Weighted overall
    const overall = Math.min(1, Math.max(0,
      textDensity * 0.20 +
      blockConsistency * 0.20 +
      identifierPresence * 0.35 +
      languageMatch * 0.25
    ));

    return { textDensity, blockConsistency, identifierPresence, languageMatch, overall };
  }
}
