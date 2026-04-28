/**
 * Interfaces for document segmentation — splitting multi-page PDFs
 * into logical document groups.
 */

export interface DocumentGroup {
  /** Group index within the parent document (0-based) */
  groupIndex: number;
  /** Detected document type for this group */
  groupType: string;
  /** Pages belonging to this group */
  pageRange: { start: number; end: number };
  /** Detected identifiers (invoice number, VIN, vendor, etc.) */
  identifiers: Record<string, string>;
  /** Confidence in this grouping */
  confidence: number;
  /** Signals that contributed to the grouping decision */
  signals: GroupingSignal[];
}

export interface GroupingSignal {
  /** Signal type */
  type: 'header_repeat' | 'identifier_match' | 'layout_similarity' | 'semantic_boundary' | 'density_shift' | 'hard_rule';
  /** Pages involved */
  pages: number[];
  /** Signal strength (0–1) */
  strength: number;
  /** Human-readable description */
  description: string;
}

export interface SegmentationResult {
  /** The discovered document groups */
  groups: DocumentGroup[];
  /** Total pages in the source PDF */
  totalPages: number;
  /** Processing time in ms */
  elapsedMs: number;
}
