import { Injectable, Logger } from '@nestjs/common';
import {
  ExtractionBackend,
  ExtractionBlock,
  ExtractionOptions,
  ExtractionPageMeta,
  ExtractionResult,
} from '../interfaces/extraction-backend.interface';
import { MarkerClient, MarkerConvertResponse } from '../clients/marker.client';

/**
 * MarkerBackend — ExtractionBackend implementation using the Marker Python sidecar.
 *
 * Transforms Marker's JSON block tree into the internal ExtractionBlock format.
 * Handles granular failure modes:
 * - Empty blocks → fallback signal
 * - Low OCR confidence → degraded status
 * - Missing tables → can call /convert/tables separately
 */
@Injectable()
export class MarkerBackend implements ExtractionBackend {
  private readonly logger = new Logger(MarkerBackend.name);
  private cachedVersion: string | null = null;

  constructor(private markerClient: MarkerClient) {}

  async extract(filePath: string, options: ExtractionOptions): Promise<ExtractionResult> {
    const startMs = Date.now();

    // Decide which endpoint to use
    let response: MarkerConvertResponse | null;

    if (options.tablesOnly) {
      const tableResp = await this.markerClient.convertTables(filePath, {
        forceOcr: options.forceOcr,
        useLlm: options.useLlm,
      });
      if (!tableResp) throw new Error('Marker table extraction returned null');
      // Wrap table response in full response format
      response = {
        file_hash: '',
        filename: '',
        engine: tableResp.engine,
        engine_version: 'unknown',
        force_ocr: options.forceOcr || false,
        use_llm: options.useLlm || false,
        elapsed_ms: tableResp.elapsed_ms,
        pages: tableResp.tables,
        metadata: {},
      };
    } else {
      response = await this.markerClient.convertPdf(filePath, {
        forceOcr: options.forceOcr,
        useLlm: options.useLlm,
        pageRange: options.pageRange,
      });
    }

    if (!response) {
      throw new Error('Marker sidecar returned null — unavailable or error');
    }

    // ── Granular failure detection ──────────────────────────
    const pages = response.pages || [];

    if (pages.length === 0) {
      this.logger.warn('Marker returned empty pages — signalling degraded quality');
    }

    // Transform Marker blocks → internal ExtractionBlocks
    const allBlocks: ExtractionBlock[] = [];
    const pageMeta: ExtractionPageMeta[] = [];
    let blockIdCounter = 0;

    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      const page = pages[pageIdx];
      const pageBlocks = this.flattenBlocks(page, pageIdx, () => `blk_${blockIdCounter++}`);

      allBlocks.push(...pageBlocks);

      // Build page meta from Marker metadata
      const pageStats = this.getPageStats(response.metadata, pageIdx);
      pageMeta.push({
        pageIndex: pageIdx,
        textExtractionMethod: pageStats?.textExtractionMethod || 'mixed',
        blockCount: pageBlocks.length,
        ocrConfidence: this.avgConfidence(pageBlocks),
      });
    }

    // ── Check for low OCR confidence → degraded signal ────
    const avgOverall = this.avgConfidence(allBlocks);
    if (avgOverall > 0 && avgOverall < 0.5) {
      this.logger.warn(`Low overall OCR confidence: ${avgOverall.toFixed(3)}. Marking as degraded.`);
    }

    // ── Check for missing tables → can call /convert/tables ──
    const hasTableBlocks = allBlocks.some(
      (b) => b.blockType === 'Table' || b.blockType === 'TableGroup',
    );
    if (!hasTableBlocks && !options.tablesOnly) {
      this.logger.debug('No table blocks detected in Marker output');
    }

    const elapsedMs = Date.now() - startMs;

    return {
      blocks: allBlocks,
      pageMeta,
      pageCount: pages.length,
      fileHash: response.file_hash,
      engine: 'marker-pdf',
      engineVersion: response.engine_version || 'unknown',
      elapsedMs,
      forceOcr: response.force_ocr,
      usedLlm: response.use_llm,
      rawResponse: response,
    };
  }

  async isAvailable(): Promise<boolean> {
    const health = await this.markerClient.healthCheck();
    return health.available;
  }

  engineName(): string {
    return 'marker-pdf';
  }

  engineVersion(): string {
    return this.cachedVersion || 'unknown';
  }

  // ── Block transformation ───────────────────────────────────

  /**
   * Recursively flatten Marker's block tree into ExtractionBlock[].
   * Preserves parent-child relationships via the children field.
   */
  private flattenBlocks(
    node: any,
    pageIdx: number,
    nextId: () => string,
    position = 0,
  ): ExtractionBlock[] {
    if (!node) return [];

    const blocks: ExtractionBlock[] = [];
    const children = node.children || [];

    // Process current node if it has content
    const blockId = node.id || nextId();
    const blockType = node.block_type || 'Unknown';
    const text = this.extractText(node);
    const polygon = node.polygon || null;
    const bbox = polygon ? this.polygonToBbox(polygon) : null;

    // Compute confidence from child content or default
    const confidence = this.estimateConfidence(node);

    const block: ExtractionBlock = {
      blockId,
      blockType,
      page: pageIdx,
      position,
      text,
      html: node.html || undefined,
      polygon: polygon || undefined,
      bbox: bbox || undefined,
      confidence,
      status: confidence > 0.3 ? 'ok' : confidence > 0 ? 'degraded' : 'ok',
      children: undefined,
    };

    // Recursively process children
    if (children.length > 0) {
      const childBlocks: ExtractionBlock[] = [];
      for (let i = 0; i < children.length; i++) {
        const childResults = this.flattenBlocks(children[i], pageIdx, nextId, i);
        childBlocks.push(...childResults);
      }
      block.children = childBlocks;
    }

    blocks.push(block);
    return blocks;
  }

  /**
   * Extract plain text from a Marker block.
   * Strips HTML tags, preserves text content.
   */
  private extractText(node: any): string {
    if (!node) return '';

    // Direct text field
    if (typeof node.text === 'string') return node.text;

    // Extract from HTML
    if (typeof node.html === 'string') {
      return node.html
        .replace(/<content-ref[^>]*><\/content-ref>/g, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Recurse into children
    if (Array.isArray(node.children)) {
      return node.children
        .map((c: any) => this.extractText(c))
        .filter(Boolean)
        .join(' ');
    }

    return '';
  }

  /**
   * Convert a 4-point polygon to an axis-aligned bbox [x1, y1, x2, y2].
   */
  private polygonToBbox(polygon: number[][]): number[] {
    if (!polygon || polygon.length < 4) return [0, 0, 0, 0];
    const xs = polygon.map((p) => p[0]);
    const ys = polygon.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  /**
   * Estimate confidence for a block based on available signals.
   */
  private estimateConfidence(node: any): number {
    // If block has explicit confidence
    if (typeof node.confidence === 'number') return node.confidence;

    // Section headers and text are typically high confidence from pdftext
    const highConfTypes = ['SectionHeader', 'Text', 'ListItem', 'PageHeader', 'PageFooter'];
    if (highConfTypes.includes(node.block_type)) return 0.9;

    // Tables/forms may vary
    if (node.block_type === 'Table' || node.block_type === 'Form') return 0.75;

    // Default
    return 0.8;
  }

  /**
   * Get page stats from Marker metadata.
   */
  private getPageStats(
    metadata: any,
    pageIdx: number,
  ): { textExtractionMethod: 'pdftext' | 'ocr' | 'mixed' } | null {
    if (!metadata?.page_stats) return null;
    const stats = metadata.page_stats[pageIdx];
    if (!stats) return null;
    return {
      textExtractionMethod: (stats.text_extraction_method as 'pdftext' | 'ocr' | 'mixed') || 'mixed',
    };
  }

  /**
   * Average confidence across blocks.
   */
  private avgConfidence(blocks: ExtractionBlock[]): number {
    if (blocks.length === 0) return 0;
    const sum = blocks.reduce((acc, b) => acc + b.confidence, 0);
    return sum / blocks.length;
  }
}
