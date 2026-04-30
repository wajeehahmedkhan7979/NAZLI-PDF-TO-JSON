import { BaseParser, RawParsedRow } from './base.parser';

/**
 * Generic Parser — Fallback for unknown formats.
 * Uses aggressive regex searching but signals lower confidence.
 */
export class GenericParser extends BaseParser {
  
  parse(block: string[], documentYear: number): RawParsedRow {
    const flags: string[] = ['TEMPLATE:GENERIC', 'FALLBACK_USED'];
    
    const chassis = this.findChassisAnchor(block);
    
    let bid: number | null = null;
    let total: number | null = null;
    let dateStr: string | null = null;

    // Search for all numbers and pick largest two as bid/total candidates
    const numbers: number[] = [];
    for (const line of block) {
      if (this.DATE_REGEX.test(line)) {
        const match = line.match(this.DATE_REGEX);
        dateStr = `${documentYear}-${match![1].replace('/', '-')}`;
        continue;
      }

      const digits = line.replace(/[^\d]/g, '');
      if (digits.length >= 5 && digits.length <= 8) {
        numbers.push(parseInt(digits, 10));
      }
    }

    numbers.sort((a, b) => b - a);
    if (numbers.length >= 2) {
      total = numbers[0];
      bid = numbers[1];
    } else if (numbers.length === 1) {
      total = numbers[0];
    }

    const result: RawParsedRow = {
      chassis,
      bid,
      total,
      date: dateStr,
      auction: 'GENERIC',
      area: null,
      lotNumber: null,
      recycle: null,
      jidosha: null,
      auctionFee: null,
      confidence: 0,
      flags,
    };

    result.confidence = this.calculateConfidence(result) * 0.8; // Lower cap for generic
    return result;
  }
}
