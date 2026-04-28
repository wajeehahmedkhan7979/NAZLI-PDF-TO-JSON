/**
 * ExtractionBackend — Pluggable interface for PDF extraction engines.
 *
 * Implementations:
 * - MarkerBackend: calls Marker Python sidecar over HTTP
 * - LegacyBackend: uses built-in pdf-parse + tesseract.js
 *
 * The orchestrator tries backends in order: Marker → Legacy fallback.
 */

export interface ExtractionOptions {
  /** Force OCR on all pages, even those with extractable text */
  forceOcr?: boolean;
  /** Use LLM to improve accuracy (requires budget approval) */
  useLlm?: boolean;
  /** Specific page range to process, e.g. "0,5-10,20" */
  pageRange?: string;
  /** Extract only tables */
  tablesOnly?: boolean;
}

export interface ExtractionBlock {
  /** Unique block ID within the document */
  blockId: string;
  /** Block type from the extraction engine */
  blockType: string;
  /** Page number (0-indexed) */
  page: number;
  /** Reading order position within the page */
  position: number;
  /** Extracted text content */
  text: string;
  /** HTML representation if available */
  html?: string;
  /** Bounding polygon: 4 corners [x,y] clockwise from top-left */
  polygon?: number[][];
  /** Axis-aligned bounding box [x1, y1, x2, y2] */
  bbox?: number[];
  /** OCR confidence for this block (0-1) */
  confidence: number;
  /** Child blocks if this is a container (e.g. Page, TableGroup) */
  children?: ExtractionBlock[];
  /** Processing status for partial failure handling */
  status: 'ok' | 'degraded' | 'failed';
  /** Error message if status is failed */
  error?: string;
}

export interface ExtractionPageMeta {
  pageIndex: number;
  textExtractionMethod: 'pdftext' | 'ocr' | 'mixed';
  blockCount: number;
  ocrConfidence?: number;
}

export interface ExtractionResult {
  /** All extracted blocks, organized by page */
  blocks: ExtractionBlock[];
  /** Per-page metadata */
  pageMeta: ExtractionPageMeta[];
  /** Total page count */
  pageCount: number;
  /** SHA-256 of the input file */
  fileHash: string;
  /** Engine that produced this result */
  engine: string;
  /** Engine version for pipeline versioning */
  engineVersion: string;
  /** Processing time in milliseconds */
  elapsedMs: number;
  /** Whether OCR was forced */
  forceOcr: boolean;
  /** Whether LLM was used */
  usedLlm: boolean;
  /** Raw engine response for debug traces */
  rawResponse?: any;
}

export interface ExtractionBackend {
  /** Run extraction on a PDF file */
  extract(filePath: string, options: ExtractionOptions): Promise<ExtractionResult>;
  /** Check if this backend is currently available */
  isAvailable(): Promise<boolean>;
  /** Return the engine name */
  engineName(): string;
  /** Return the engine version for pipeline versioning */
  engineVersion(): string;
}
