import { BaseParser, RawParsedRow } from './base.parser';

/**
 * TAA Template Parser — Specialized for TAA Auction formats.
 */
export class TAAParser extends BaseParser {
  
  parse(block: string[], documentYear: number): RawParsedRow {
    const flags: string[] = ['TEMPLATE:TAA'];
    
    const chassis = this.findChassisAnchor(block);
    if (!chassis) flags.push('CHASSIS_NOT_FOUND');

    // TAA specific: Bid and Total might be in different indices than USS
    // For now, let's use a robust searching approach within the template
    
    let bid: number | null = null;
    let total: number | null = null;
    let dateStr: string | null = null;

    for (const line of block) {
      // Date
      if (!dateStr && this.DATE_REGEX.test(line)) {
        const match = line.match(this.DATE_REGEX);
        dateStr = `${documentYear}-${match![1].replace('/', '-')}`;
      }

      // Large numbers (Bid/Total)
      const digits = line.replace(/[^\d]/g, '');
      if (digits.length >= 5 && digits.length <= 8) {
        const val = parseInt(digits, 10);
        if (!bid) bid = val;
        else if (!total) total = val;
      }
    }

    // TAA sometimes swaps Bid/Total order if the car was sold for less? No, usually Bid < Total.
    if (bid && total && bid > total) {
      [bid, total] = [total, bid];
    }

    const result: RawParsedRow = {
      chassis,
      bid,
      total,
      date: dateStr,
      auction: 'TAA',
      area: null,
      lotNumber: null,
      recycle: null,
      jidosha: null,
      auctionFee: null,
      confidence: 0,
      flags,
    };

    result.confidence = this.calculateConfidence(result);
    return result;
  }
}
