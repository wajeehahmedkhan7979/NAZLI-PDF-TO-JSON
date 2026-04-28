/**
 * Strategy interface for document-type-specific processing.
 * Each document type (Invoice, AuctionSheet, etc.) implements this.
 */
export interface DocumentProcessor {
  /**
   * Process a document through the full type-specific pipeline.
   * Returns the canonical JSON output specific to the document type.
   */
  process(documentId: string): Promise<DocumentProcessorResult>;
}

export interface DocumentProcessorResult {
  /** The type discriminator */
  type: string;
  /** The canonical output payload */
  payload: any;
  /** Overall confidence score for the processing result */
  confidence: number;
  /** Quality flags detected during processing */
  flags: string[];
}
