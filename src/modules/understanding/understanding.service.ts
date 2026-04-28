import { Injectable, Logger } from '@nestjs/common';
import { ExtractionBlock } from '../extraction/interfaces/extraction-backend.interface';
import {
  UnderstandingResult,
  UnderstoodBlock,
} from './interfaces/understanding.interfaces';
import { BlockNormalizer } from './processors/block-normalizer';
import { TableReconstructor } from './processors/table-reconstructor';
import { KeyValueDetector } from './processors/key-value-detector';
import { SectionClassifier } from './processors/section-classifier';
import { FieldCandidateBuilder } from './processors/field-candidate-builder';

/**
 * UnderstandingService — orchestrates the Document Understanding Layer.
 *
 * Pipeline:
 *   Raw Blocks → Normalize → Classify Sections → Detect KV Pairs
 *                → Reconstruct Tables → Build Field Candidates
 *
 * This layer transforms noisy extraction output into semantically-enriched
 * blocks that the schema mapper can reliably consume.
 */
@Injectable()
export class UnderstandingService {
  private readonly logger = new Logger(UnderstandingService.name);

  constructor(
    private blockNormalizer: BlockNormalizer,
    private tableReconstructor: TableReconstructor,
    private kvDetector: KeyValueDetector,
    private sectionClassifier: SectionClassifier,
    private fieldCandidateBuilder: FieldCandidateBuilder,
  ) {}

  /**
   * Run the full understanding pipeline on extraction blocks.
   */
  async understand(blocks: ExtractionBlock[]): Promise<UnderstandingResult> {
    const startMs = Date.now();
    this.logger.log(`Understanding pipeline started: ${blocks.length} input blocks`);

    // ── Step 1: Block Normalization ───────────────────────────
    // Merge fragments, deduplicate, normalize text, fix reading order
    const normalizedBlocks: UnderstoodBlock[] = this.blockNormalizer.normalize(blocks);
    this.logger.debug(`After normalization: ${normalizedBlocks.length} blocks`);

    // ── Step 2: Section Classification ───────────────────────
    // Assign section types (HEADER, PARTIES, LINE_ITEMS, TOTALS, etc.)
    const classifiedBlocks = this.sectionClassifier.classify(normalizedBlocks);
    this.logger.debug('Section classification complete');

    // ── Step 3: Key-Value Detection ──────────────────────────
    // Find label→value pairs using spatial/keyword patterns
    const keyValuePairs = this.kvDetector.detect(classifiedBlocks);
    this.logger.debug(`Detected ${keyValuePairs.length} key-value pairs`);

    // ── Step 4: Table Reconstruction ─────────────────────────
    // Reconstruct full table grids with granular confidence
    const tables = this.tableReconstructor.reconstructTables(classifiedBlocks);
    this.logger.debug(`Reconstructed ${tables.length} tables`);

    // ── Step 5: Field Candidate Building ─────────────────────
    // Produce ranked, typed candidates for the schema mapper
    const fieldCandidates = this.fieldCandidateBuilder.buildCandidates(
      classifiedBlocks,
      keyValuePairs,
    );
    this.logger.debug(`Built ${fieldCandidates.length} field candidates`);

    // ── Build page section map ───────────────────────────────
    const pageSections = new Map<number, string[]>();
    for (const block of classifiedBlocks) {
      if (!pageSections.has(block.page)) pageSections.set(block.page, []);
      const sections = pageSections.get(block.page)!;
      if (!sections.includes(block.sectionType)) {
        sections.push(block.sectionType);
      }
    }

    const elapsedMs = Date.now() - startMs;

    this.logger.log(
      `Understanding pipeline complete: ${classifiedBlocks.length} blocks, ` +
        `${tables.length} tables, ${keyValuePairs.length} KV pairs, ` +
        `${fieldCandidates.length} candidates in ${elapsedMs}ms`,
    );

    return {
      blocks: classifiedBlocks,
      tables,
      keyValuePairs,
      fieldCandidates,
      pageSections: pageSections as any,
      elapsedMs,
    };
  }
}
