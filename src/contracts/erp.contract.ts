/**
 * ERP Export Contract
 * Single source of truth for the output schema ingested by downstream ERP systems.
 */

export interface ErpPurchaseRecord {
  // Vehicle Info
  chassis_number: string;      // Strict format enforced
  lot_number?: string;
  auction_house: string;
  auction_date: string;       // ISO-8601
  
  // Financials (Strict Integers)
  bid_price: number;
  recycle_fee: number;
  consumption_tax: number;
  auction_fee: number;
  total_amount: number;
  
  // Logic Meta
  is_math_valid: boolean;
  overall_confidence: number;
  export_version: string;
}

export interface ErpPayload {
  batch_id: string;
  timestamp: string;
  records: ErpPurchaseRecord[];
}
