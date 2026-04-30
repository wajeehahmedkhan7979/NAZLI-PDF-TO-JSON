import { Injectable, Logger } from '@nestjs/common';
import { UnderstoodBlock, FieldCandidate } from '../understanding/interfaces/understanding.interfaces';
import {
  DocumentGroup,
  GroupingSignal,
  SegmentationResult,
} from './interfaces/segmentation.interfaces';

/**
 * SegmentationService — splits multi-page PDFs into logical document groups.
 *
 * Uses a hybrid approach:
 * 1. Hard rules (force boundary on invoice/vendor change)
 * 2. Weighted multi-signal scoring for ambiguous boundaries
 *
 * Signal weights:
 *   headerSimilarity:      0.25
 *   identifierMatch:       0.30
 *   layoutSimilarity:      0.15
 *   semanticSectionChange: 0.20
 *   pageDensityChange:     0.10
 */
@Injectable()
export class SegmentationService {
  private readonly logger = new Logger(SegmentationService.name);

  /** Hard boundary keyword anchors — force a new group */
  private readonly HARD_BOUNDARY_KEYWORDS = [
    '請求書',      // Invoice
    'オークション計算書', // Auction calculation sheet
    '納品書',      // Delivery note
    '見積書',      // Quotation
    '注文書',      // Purchase order
  ];

  /** Signal weights */
  private readonly WEIGHTS = {
    headerSimilarity: 0.20,
    identifierMatch: 0.25,
    layoutSimilarity: 0.10,
    semanticSectionChange: 0.15,
    pageDensityChange: 0.10,
    columnStructureChange: 0.20, // New signal
  };

  /** Base threshold for splitting into a new group */
  private readonly BASE_THRESHOLD = 0.55;
  /** Type-specific threshold adjustments */
  private readonly THRESHOLD_ADJUSTMENTS: Record<string, number> = {
    BILLING: 0.10,       // stricter (fewer false splits)
    PURCHASE: 0.05,
    AUCTION_SHEET: -0.10, // looser (auction sheets vary more)
  };

  /**
   * Segment understood blocks into logical document groups.
   */
  segment(
    blocks: UnderstoodBlock[],
    fieldCandidates: FieldCandidate[],
    totalPages: number,
  ): SegmentationResult {
    const startMs = Date.now();

    if (totalPages <= 1) {
      // Build a minimal profile for single-page type detection
      const singleProfile: any = {
        hasHeader: blocks.some((b) => b.sectionType === 'HEADER'),
        headerText: blocks
          .filter((b) => b.sectionType === 'HEADER' || b.normalizedText)
          .map((b) => b.normalizedText)
          .join(' '),
        sections: [...new Set(blocks.map((b) => b.sectionType))],
        blockTypes: blocks.map((b) => b.blockType),
        blockCount: blocks.length,
        textLength: blocks.reduce((s, b) => s + b.normalizedText.length, 0),
        identifiers: this.collectIdentifiers(fieldCandidates, [0]),
        containsHardBoundaryKeyword: this.containsHardBoundary(blocks),
      };
      const groupType = this.detectGroupType([singleProfile], fieldCandidates);
      return {
        groups: [{
          groupIndex: 0,
          groupType,
          pageRange: { start: 0, end: 0 },
          identifiers: singleProfile.identifiers,
          confidence: 1.0,
          signals: [],
        }],
        totalPages,
        elapsedMs: Date.now() - startMs,
      };
    }

    // Build per-page profiles
    const pageProfiles = this.buildPageProfiles(blocks, fieldCandidates, totalPages);

    // Find boundary points
    const boundaries = this.detectBoundaries(pageProfiles);

    // Build groups from boundaries
    const groups = this.buildGroups(boundaries, pageProfiles, fieldCandidates, totalPages);

    const elapsedMs = Date.now() - startMs;

    this.logger.log(
      `Segmentation: ${totalPages} pages → ${groups.length} groups in ${elapsedMs}ms`,
    );

    return { groups, totalPages, elapsedMs };
  }

  // ── Page Profiling ─────────────────────────────────────────

  private buildPageProfiles(
    blocks: UnderstoodBlock[],
    candidates: FieldCandidate[],
    totalPages: number,
  ): PageProfile[] {
    const profiles: PageProfile[] = [];

    for (let page = 0; page < totalPages; page++) {
      const pageBlocks = blocks.filter((b) => b.page === page);
      const pageCandidates = candidates.filter((c) => c.page === page);

      profiles.push({
        page,
        blockCount: pageBlocks.length,
        textLength: pageBlocks.reduce((sum, b) => sum + b.normalizedText.length, 0),
        sections: [...new Set(pageBlocks.map((b) => b.sectionType))],
        hasHeader: pageBlocks.some((b) => b.sectionType === 'HEADER'),
        headerText: pageBlocks
          .filter((b) => b.sectionType === 'HEADER')
          .map((b) => b.normalizedText)
          .join(' '),
        identifiers: this.collectIdentifiers(pageCandidates, [page]),
        invoiceNumber: pageCandidates.find((c) => c.fieldType === 'INVOICE_NUMBER')?.value,
        vendorName: pageCandidates.find((c) => c.fieldType === 'VENDOR')?.value,
        blockTypes: pageBlocks.map((b) => b.blockType),
        containsHardBoundaryKeyword: this.containsHardBoundary(pageBlocks),
        columnFingerprint: this.buildColumnFingerprint(pageBlocks),
      });
    }

    return profiles;
  }

  // ── Boundary Detection ─────────────────────────────────────

  private detectBoundaries(profiles: PageProfile[]): BoundaryPoint[] {
    const boundaries: BoundaryPoint[] = [];

    // Page 0 is always a boundary
    boundaries.push({
      page: 0,
      score: 1.0,
      signals: [{ type: 'hard_rule', pages: [0], strength: 1.0, description: 'First page' }],
    });

    for (let i = 1; i < profiles.length; i++) {
      const prev = profiles[i - 1];
      const curr = profiles[i];
      const signals: GroupingSignal[] = [];
      let weightedScore = 0;

      // ── Hard rules (override scoring) ────────────────────
      if (curr.containsHardBoundaryKeyword && prev.containsHardBoundaryKeyword) {
        // Both pages have document-title keywords → likely new document
        signals.push({
          type: 'hard_rule',
          pages: [i],
          strength: 1.0,
          description: `Repeated document keyword on page ${i}`,
        });
        boundaries.push({ page: i, score: 1.0, signals });
        continue;
      }

      // Hard rule: invoice number changed
      if (curr.invoiceNumber && prev.invoiceNumber && curr.invoiceNumber !== prev.invoiceNumber) {
        signals.push({
          type: 'hard_rule',
          pages: [i - 1, i],
          strength: 1.0,
          description: `Invoice number changed: ${prev.invoiceNumber} → ${curr.invoiceNumber}`,
        });
        boundaries.push({ page: i, score: 1.0, signals });
        continue;
      }

      // Hard rule: vendor changed
      if (curr.vendorName && prev.vendorName && curr.vendorName !== prev.vendorName) {
        signals.push({
          type: 'hard_rule',
          pages: [i - 1, i],
          strength: 0.95,
          description: `Vendor changed: ${prev.vendorName} → ${curr.vendorName}`,
        });
        boundaries.push({ page: i, score: 0.95, signals });
        continue;
      }

      // ── Weighted scoring for ambiguous cases ─────────────

      // Signal 1: Header similarity
      const headerSim = this.headerSimilarity(prev, curr);
      if (headerSim > 0) {
        const strength = headerSim;
        weightedScore += strength * this.WEIGHTS.headerSimilarity;
        signals.push({
          type: 'header_repeat',
          pages: [i - 1, i],
          strength,
          description: `Header repeated (similarity: ${strength.toFixed(2)})`,
        });
      }

      // Signal 2: Identifier continuity (same identifiers = same group)
      const idMatch = this.identifierContinuity(prev, curr);
      if (idMatch < 0.5) {
        // Low continuity = likely boundary
        const strength = 1 - idMatch;
        weightedScore += strength * this.WEIGHTS.identifierMatch;
        signals.push({
          type: 'identifier_match',
          pages: [i - 1, i],
          strength,
          description: `Identifier discontinuity (continuity: ${idMatch.toFixed(2)})`,
        });
      }

      // Signal 3: Layout similarity
      const layoutSim = this.layoutSimilarity(prev, curr);
      if (layoutSim < 0.5) {
        const strength = 1 - layoutSim;
        weightedScore += strength * this.WEIGHTS.layoutSimilarity;
        signals.push({
          type: 'layout_similarity',
          pages: [i - 1, i],
          strength,
          description: `Layout shift (similarity: ${layoutSim.toFixed(2)})`,
        });
      }

      // Signal 4: Semantic section change
      const sectionChange = this.semanticBoundary(prev, curr);
      if (sectionChange > 0) {
        weightedScore += sectionChange * this.WEIGHTS.semanticSectionChange;
        signals.push({
          type: 'semantic_boundary',
          pages: [i],
          strength: sectionChange,
          description: `Semantic section restart detected`,
        });
      }

      // Signal 5: Page density change
      const densityChange = this.densityShift(prev, curr);
      if (densityChange > 0.3) {
        weightedScore += densityChange * this.WEIGHTS.pageDensityChange;
        signals.push({
          type: 'density_shift',
          pages: [i - 1, i],
          strength: densityChange,
          description: `Content density shift (${prev.blockCount} → ${curr.blockCount} blocks)`,
        });
      }

      // Signal 6: Column Fingerprint Similarity
      const colSim = this.columnFingerprintSimilarity(prev, curr);
      if (colSim < 0.6) { // High mismatch in column structure
        const strength = 1 - colSim;
        weightedScore += strength * this.WEIGHTS.columnStructureChange;
        signals.push({
          type: 'column_structure_change',
          pages: [i - 1, i],
          strength,
          description: `Column structure mismatch (similarity: ${colSim.toFixed(2)})`,
        });
      }

      // Dynamic threshold: base + variance factor + type adjustment
      const threshold = this.computeDynamicThreshold(signals, profiles);

      if (weightedScore >= threshold) {
        boundaries.push({ page: i, score: weightedScore, signals });
      }
    }

    return boundaries;
  }

  // ── Group Building ─────────────────────────────────────────

  private buildGroups(
    boundaries: BoundaryPoint[],
    profiles: PageProfile[],
    candidates: FieldCandidate[],
    totalPages: number,
  ): DocumentGroup[] {
    const sortedBoundaries = boundaries.sort((a, b) => a.page - b.page);
    const groups: DocumentGroup[] = [];

    for (let i = 0; i < sortedBoundaries.length; i++) {
      const start = sortedBoundaries[i].page;
      const end = i < sortedBoundaries.length - 1
        ? sortedBoundaries[i + 1].page - 1
        : totalPages - 1;

      const pageRange = Array.from({ length: end - start + 1 }, (_, k) => start + k);
      const groupCandidates = candidates.filter((c) => pageRange.includes(c.page));
      const identifiers = this.collectIdentifiers(groupCandidates, pageRange);

      // Detect group type from identifiers or content
      const groupType = this.detectGroupType(profiles.slice(start, end + 1), groupCandidates);

      groups.push({
        groupIndex: i,
        groupType,
        pageRange: { start, end },
        identifiers,
        confidence: sortedBoundaries[i].score,
        signals: sortedBoundaries[i].signals,
      });
    }

    return groups;
  }

  // ── Signal Computation Helpers ─────────────────────────────

  private headerSimilarity(prev: PageProfile, curr: PageProfile): number {
    if (!prev.hasHeader || !curr.hasHeader) return 0;
    if (!prev.headerText || !curr.headerText) return 0;

    // Simple Jaccard similarity on header words
    const aWords = new Set(prev.headerText.split(/\s+/));
    const bWords = new Set(curr.headerText.split(/\s+/));
    const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
    const union = new Set([...aWords, ...bWords]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private identifierContinuity(prev: PageProfile, curr: PageProfile): number {
    const prevIds = Object.entries(prev.identifiers);
    const currIds = Object.entries(curr.identifiers);

    if (prevIds.length === 0 || currIds.length === 0) return 0.5; // Unknown

    let matches = 0;
    let comparisons = 0;

    for (const [key, val] of prevIds) {
      if (curr.identifiers[key]) {
        comparisons++;
        if (curr.identifiers[key] === val) matches++;
      }
    }

    return comparisons > 0 ? matches / comparisons : 0.5;
  }

  private layoutSimilarity(prev: PageProfile, curr: PageProfile): number {
    // Compare block type distributions
    const prevTypes = this.typeDistribution(prev.blockTypes);
    const currTypes = this.typeDistribution(curr.blockTypes);

    const allTypes = new Set([...Object.keys(prevTypes), ...Object.keys(currTypes)]);
    let similarity = 0;
    let total = 0;

    for (const type of allTypes) {
      const pVal = prevTypes[type] || 0;
      const cVal = currTypes[type] || 0;
      similarity += Math.min(pVal, cVal);
      total += Math.max(pVal, cVal);
    }

    return total > 0 ? similarity / total : 0.5;
  }

  private semanticBoundary(prev: PageProfile, curr: PageProfile): number {
    // A new document typically starts with HEADER sections
    if (curr.hasHeader && curr.sections.includes('HEADER')) {
      // If the previous page had TOTALS or FOOTER, strong signal
      if (prev.sections.includes('TOTALS') || prev.sections.includes('FOOTER')) {
        return 0.9;
      }
      return 0.5;
    }
    return 0;
  }

  private densityShift(prev: PageProfile, curr: PageProfile): number {
    if (prev.blockCount === 0 && curr.blockCount === 0) return 0;
    const maxCount = Math.max(prev.blockCount, curr.blockCount, 1);
    return Math.abs(prev.blockCount - curr.blockCount) / maxCount;
  }

  private containsHardBoundary(blocks: UnderstoodBlock[]): boolean {
    return blocks.some((b) =>
      this.HARD_BOUNDARY_KEYWORDS.some((kw) => b.normalizedText.includes(kw)),
    );
  }

  private collectIdentifiers(
    candidates: FieldCandidate[],
    pages: number[],
  ): Record<string, string> {
    const ids: Record<string, string> = {};
    const relevantTypes = [
      'VIN', 'CHASSIS', 'INVOICE_NUMBER', 'VENDOR', 'CLIENT',
      'LOT_NUMBER', 'MODEL_CODE',
    ];

    for (const c of candidates) {
      if (!pages.includes(c.page)) continue;
      if (relevantTypes.includes(c.fieldType) && c.confidence > 0.5) {
        if (!ids[c.fieldType] || c.confidence > 0.7) {
          ids[c.fieldType] = c.value;
        }
      }
    }

    return ids;
  }

  private detectGroupType(profiles: PageProfile[], candidates: FieldCandidate[]): string {
    // Check for auction sheet keywords
    const allText = profiles.map((p) => p.headerText).join(' ');
    if (allText.includes('オークション') || allText.includes('TC-web') || allText.includes('ANS')) {
      return 'AUCTION_SHEET';
    }

    // Check by field candidates
    if (candidates.some((c) => c.fieldType === 'CHASSIS' || c.fieldType === 'VIN')) {
      return 'PURCHASE';
    }
    if (candidates.some((c) => c.fieldType === 'INVOICE_NUMBER')) {
      return 'BILLING';
    }

    return 'UNKNOWN';
  }

  private typeDistribution(types: string[]): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const t of types) {
      dist[t] = (dist[t] || 0) + 1;
    }
    // Normalize
    const total = types.length || 1;
    for (const key of Object.keys(dist)) {
      dist[key] /= total;
    }
    return dist;
  }

  /**
   * Compute a dynamic segmentation threshold based on:
   * 1. Signal variance (high variance = more uncertainty = stricter threshold)
   * 2. Detected document type (billing = stricter, auction = looser)
   *
   * Formula: clamp(base + variance_factor + type_adjustment, 0.35, 0.85)
   */
  private computeDynamicThreshold(
    signals: GroupingSignal[],
    profiles: PageProfile[],
  ): number {
    let threshold = this.BASE_THRESHOLD;

    // Variance factor: if signals are inconsistent, be more cautious (raise threshold)
    if (signals.length > 0) {
      const strengths = signals.map((s) => s.strength);
      const mean = strengths.reduce((a, b) => a + b, 0) / strengths.length;
      const variance = strengths.reduce((a, s) => a + Math.pow(s - mean, 2), 0) / strengths.length;
      const stddev = Math.sqrt(variance);
      threshold += stddev * 0.1; // Higher variance → higher bar to split
    }

    // Type-based adjustment: detect dominant doc type from profiles
    const allHeaderText = profiles.map((p) => p.headerText).join(' ');
    for (const [type, adj] of Object.entries(this.THRESHOLD_ADJUSTMENTS)) {
      if (type === 'BILLING' && (allHeaderText.includes('請求書') || allHeaderText.includes('納品書'))) {
        threshold += adj;
        break;
      }
      if (type === 'AUCTION_SHEET' && (allHeaderText.includes('オークション') || allHeaderText.includes('TC-web'))) {
        threshold += adj;
        break;
      }
      if (type === 'PURCHASE' && allHeaderText.includes('注文書')) {
        threshold += adj;
        break;
      }
    }

    // Clamp to safe range
    return Math.max(0.35, Math.min(0.85, threshold));
  }
  private buildColumnFingerprint(blocks: UnderstoodBlock[]): any {
    const textBlocks = blocks.filter(b => b.blockType === 'TEXT' || b.blockType === 'TABLE');
    const numBlocks = textBlocks.length;
    
    let numericChars = 0;
    let totalChars = 0;
    textBlocks.forEach(b => {
      const text = b.normalizedText;
      totalChars += text.length;
      numericChars += (text.match(/\d/g) || []).length;
    });
    const numericRatio = totalChars > 0 ? numericChars / totalChars : 0;
    
    // Approximate columns by counting distinct X-alignments (binned to ~50px)
    const xPositions = new Set();
    blocks.forEach(b => {
      const bbox = (b as any).metadata?.bbox;
      if (bbox) xPositions.add(Math.round(bbox[0] / 50) * 50);
    });
    
    return { numBlocks, numericRatio, colCount: xPositions.size };
  }

  private columnFingerprintSimilarity(prev: PageProfile, curr: PageProfile): number {
    const f1 = prev.columnFingerprint;
    const f2 = curr.columnFingerprint;
    if (!f1 || !f2) return 1.0;

    const blockRatio = Math.min(f1.numBlocks, f2.numBlocks) / Math.max(f1.numBlocks, f2.numBlocks, 1);
    const numDiff = 1 - Math.abs(f1.numericRatio - f2.numericRatio);
    const colRatio = Math.min(f1.colCount, f2.colCount) / Math.max(f1.colCount, f2.colCount, 1);

    return (blockRatio * 0.3) + (numDiff * 0.4) + (colRatio * 0.3);
  }
}

// ── Internal types ───────────────────────────────────────────

interface PageProfile {
  page: number;
  blockCount: number;
  textLength: number;
  sections: string[];
  hasHeader: boolean;
  headerText: string;
  identifiers: Record<string, string>;
  invoiceNumber?: string;
  vendorName?: string;
  blockTypes: string[];
  containsHardBoundaryKeyword: boolean;
  columnFingerprint?: {
    numBlocks: number;
    numericRatio: number;
    colCount: number;
  };
}

interface BoundaryPoint {
  page: number;
  score: number;
  signals: GroupingSignal[];
}
