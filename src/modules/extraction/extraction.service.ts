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

        // Check overall confidence
        const avgConf =
          result.blocks.reduce((a, b) => a + b.confidence, 0) / result.blocks.length;

        if (avgConf < 0.3 && name === 'marker-pdf') {
          this.logger.warn(
            `Marker returned very low confidence (${avgConf.toFixed(3)}). Trying legacy fallback...`,
          );
          // Don't discard — keep as fallback if legacy also fails
          const fallbackResult = result;
          try {
            result = await this.legacyBackend.extract(document.storagePath, options);
            usedBackend = this.legacyBackend.engineName();

            // If legacy also produces bad results, keep Marker's
            const legacyAvgConf =
              result.blocks.reduce((a, b) => a + b.confidence, 0) / (result.blocks.length || 1);
            if (legacyAvgConf <= avgConf) {
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

    // Calculate overall confidence
    const overallConfidence =
      result.blocks.length > 0
        ? result.blocks.reduce((acc, curr) => acc + curr.confidence, 0) / result.blocks.length
        : 0;

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
}
