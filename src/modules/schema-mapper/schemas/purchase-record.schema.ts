/**
 * PurchaseRecord — The strict canonical schema for ERP consumption.
 * This structure represents a single row in the purchase/auction dataset.
 */
export interface PurchaseRecord {
  /** Processing date in ISO format (YYYY-MM-DD) */
  date: string;
  
  /** Auction house name (e.g., USS, TAA, HAA) */
  auction: string;
  
  /** Geographical location or venue (e.g., Kobe, Yokohama) */
  area: string;
  
  /** The specific lot number for the vehicle */
  lotNumber: string;
  
  /** Vehicle model year (Gregorian) */
  year: number;
  
  /** Unique vehicle identifier (Chassis ID / VIN) */
  chassis: string;
  
  /** The winning bid amount (Hammer price) */
  bid: number;
  
  /** Recycling fee amount */
  recycle: number;
  
  /** Automobile tax (Jidosha-zei) */
  jidosha: number;
  
  /** Auction house convenience/service fee */
  auctionFee: number;
  
  /** Total calculated invoice amount */
  total: number;
  
  /** Shipping Agent */
  sAgent?: string;
  
  /** Destination Country */
  country?: string;
  
  /** Clearing Agent */
  cAgent?: string;
  
  /** Port of Loading */
  pol?: string;
  
  /** Transport cost (Rikso) */
  rikso?: number;
}

/**
 * Metadata for the entire extraction job.
 */
export interface PurchaseExtractionResult {
  success: boolean;
  confidence: number;
  records: PurchaseRecord[];
  warnings: string[];
  errors: string[];
}
