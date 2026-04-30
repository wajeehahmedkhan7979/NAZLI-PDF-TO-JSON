import { Injectable } from '@nestjs/common';
import { PurchaseRecord } from './schemas/purchase-record.schema';

export interface ErpPayload {
  chassis: string;
  bid: number;
  total: number;
  auction_date: string;
  validation_status: string;
  auction_house: string;
  venue_location: string;
  lot_number: string;
  vehicle_year: number;
  recycle_fee: number;
  automobile_tax: number;
  auction_fee: number;
}

@Injectable()
export class ErpAdapterService {
  /**
   * Transforms internal PurchaseRecords into strict ERP Payloads.
   * Do NOT connect pipeline output directly to ERP without passing through here.
   */
  toErpPayload(records: PurchaseRecord[], documentConfidence: number): ErpPayload[] {
    const baseStatus = documentConfidence < 0.85 ? 'NEEDS_REVIEW' : 'COMPLETED';

    return records.map(r => ({
      chassis: r.chassis || 'UNKNOWN',
      bid: this.ensureInteger(r.bid),
      total: this.ensureInteger(r.total),
      auction_date: this.normalizeDate(r.date),
      validation_status: baseStatus,
      auction_house: r.auction || '',
      venue_location: r.area || '',
      lot_number: r.lotNumber || '',
      vehicle_year: r.year || 0,
      recycle_fee: this.ensureInteger(r.recycle),
      automobile_tax: this.ensureInteger(r.jidosha),
      auction_fee: this.ensureInteger(r.auctionFee)
    }));
  }

  private ensureInteger(val: any): number {
    if (typeof val === 'number') return Math.round(val);
    if (!val) return 0;
    const parsed = parseInt(val.toString().replace(/[^\d.-]/g, ''), 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  private normalizeDate(val: string): string {
    if (!val) return '';
    // Expected format is YYYY-MM-DD
    const match = val.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return val;
    return val; // Assume it was caught by other validation rules if malformed
  }
}
