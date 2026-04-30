/**
 * Interfaces for the Document Understanding Layer.
 *
 * This layer sits between raw extraction (Marker/legacy) and segmentation/mapping.
 * It reconstructs semantic meaning from noisy OCR blocks.
 */

import { ExtractionBlock } from '../../extraction/interfaces/extraction-backend.interface';

// ── Understood Block ─────────────────────────────────────────────

export interface UnderstoodBlock extends ExtractionBlock {
  /** Normalized text (fullwidth → halfwidth, whitespace cleaned) */
  normalizedText: string;
  /** Semantic section this block belongs to */
  sectionType: SectionType;
  /** Confidence in section classification */
  sectionConfidence: number;
  /** Whether this block was merged from multiple fragments */
  wasMerged: boolean;
  /** IDs of blocks that were merged into this one */
  mergedFrom?: string[];
}

export type SectionType =
  | 'HEADER'
  | 'PARTIES'
  | 'VEHICLE_INFO'
  | 'LINE_ITEMS'
  | 'TOTALS'
  | 'FOOTER'
  | 'NOTES'
  | 'TABLE'
  | 'FORM'
  | 'UNKNOWN';

// ── Reconstructed Table ──────────────────────────────────────────

export interface ReconstructedTable {
  /** Table ID */
  tableId: string;
  /** Page where the table appears */
  page: number;
  /** Detected column headers */
  headers: TableCell[];
  /** Data rows */
  rows: TableRow[];
  /** Bounding box of the entire table */
  bbox?: number[];
  /** Granular confidence breakdown */
  confidence: TableConfidence;
}

export interface TableRow {
  rowIndex: number;
  cells: TableCell[];
  /** Row spans multiple source lines */
  isMultiLine: boolean;
}

export interface TableCell {
  text: string;
  columnIndex: number;
  rowIndex: number;
  bbox?: number[];
  /** Spans multiple columns */
  colSpan: number;
  /** Spans multiple rows */
  rowSpan: number;
  confidence: number;
}

export interface TableConfidence {
  /** Row/column alignment regularity (0-1) */
  gridIntegrity: number;
  /** Header detection quality (0-1) */
  headerConfidence: number;
  /** Consistency of cell content types within columns (0-1) */
  cellConsistency: number;
  /** Merged cell detection accuracy (0-1) */
  mergeAccuracy: number;
  /** Overall weighted confidence */
  overall: number;
}

// ── Key-Value Pair ───────────────────────────────────────────────

export interface KeyValuePair {
  /** The label/key text */
  label: string;
  /** The value text */
  value: string;
  /** Source block ID */
  sourceBlockId: string;
  /** Page number */
  page: number;
  /** Bounding box of the label */
  labelBbox?: number[];
  /** Bounding box of the value */
  valueBbox?: number[];
  /** Detection confidence */
  confidence: number;
  /** How the pair was detected */
  detectionMethod: 'label_colon_value' | 'label_above_value' | 'label_left_value' | 'keyword_anchor';
}

// ── Field Candidate ──────────────────────────────────────────────

export type FieldType =
  | 'VIN'
  | 'CHASSIS'
  | 'TOTAL'
  | 'SUBTOTAL'
  | 'TAX'
  | 'DATE'
  | 'INVOICE_NUMBER'
  | 'BUYER'
  | 'SELLER'
  | 'VEHICLE_NAME'
  | 'MODEL_CODE'
  | 'AUCTION_FEE'
  | 'RECYCLE_FEE'
  | 'LOT_NUMBER'
  | 'VENUE'
  | 'VENDOR'
  | 'CLIENT'
  | 'CURRENCY_AMOUNT'
  | 'BANK_ACCOUNT'
  | 'PHONE'
  | 'POSTAL_CODE'
  | 'UNKNOWN';

export interface FieldCandidate {
  /** What kind of field this might be */
  fieldType: FieldType;
  /** The extracted value */
  value: string;
  /** Source block ID */
  sourceBlockId: string;
  /** Page number */
  page: number;
  /** Overall confidence in this candidate (weighted composite) */
  confidence: number;
  /** Decomposed confidence scores for explainability */
  confidenceBreakdown?: {
    /** How well the nearby label matches expected labels (0-1) */
    labelMatch: number;
    /** Whether the block is in the expected section (0-1) */
    sectionAlignment: number;
    /** Spatial consistency with expected field position (0-1) */
    spatialConsistency: number;
    /** How well the value format matches the expected pattern (0-1) */
    valueFormat: number;
  };
  /** Contextual information for ranking */
  context: {
    /** Which section the block is in */
    section: SectionType;
    /** Nearby label text */
    nearbyLabels: string[];
    /** Key-value pair if detected */
    kvPair?: KeyValuePair;
  };
  /** Spatial metadata for row grouping */
  metadata?: {
    bbox?: number[];
  };
}

// ── Understanding Result ─────────────────────────────────────────

export interface UnderstandingResult {
  /** Semantically-enriched blocks */
  blocks: UnderstoodBlock[];
  /** Reconstructed tables */
  tables: ReconstructedTable[];
  /** Detected key-value pairs */
  keyValuePairs: KeyValuePair[];
  /** Ranked field candidates */
  fieldCandidates: FieldCandidate[];
  /** Per-page section map */
  pageSections: Map<number, SectionType[]>;
  /** Processing time in ms */
  elapsedMs: number;
}
