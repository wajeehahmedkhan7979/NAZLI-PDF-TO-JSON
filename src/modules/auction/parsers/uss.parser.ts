import { BaseParser, RawParsedRow } from './base.parser';

/**
 * USS Template Parser — Specialized for USS Auction formats.
 */
export class USSParser extends BaseParser {
  
  parse(block: string[], documentYear: number): RawParsedRow {
    const flags: string[] = ['TEMPLATE:USS'];
    
    // 1. Anchor by Chassis (MANDATORY)
    const chassis = this.findChassisAnchor(block);
    if (!chassis) flags.push('CHASSIS_NOT_FOUND');

    // 2. Extract Date and Bid (Line 2 typically)
    let dateStr: string | null = null;
    let bid: number | null = null;
    const dateLine = block.find(l => this.DATE_REGEX.test(l));
    if (dateLine) {
      const dateMatch = dateLine.match(this.DATE_REGEX);
      if (dateMatch) {
        dateStr = `${documentYear}-${dateMatch[1].replace('/', '-')}`;
        const afterDate = dateLine.substring(dateMatch.index! + dateMatch[0].length);
        bid = this.parseNumeric(afterDate);
      }
    }

    // 3. Extract packed line for Total, Recycle, Jidosha (Line 4/5)
    // USS packed lines are often > 10 digits
    const packedLine = block.find(l => /^\d{10,}$/.test(l.trim()));
    let total: number | null = null;
    let recycle: number | null = null;
    let jidosha: number | null = null;
    
    if (packedLine) {
      const digits = packedLine.trim();
      // Heuristic for USS packed line: [Total][Recycle][Jidosha]
      // Total is usually first 6-7 digits
      total = parseInt(digits.substring(0, digits.length - 8), 10);
      recycle = parseInt(digits.substring(digits.length - 8, digits.length - 4), 10);
      jidosha = parseInt(digits.substring(digits.length - 4), 10);
    }

    // 4. Standalone subtotal check (Line 5 fallback)
    if (!total) {
      const subtotalLine = block.find(l => /^\d{5,7}$/.test(l.trim()));
      if (subtotalLine) total = this.parseNumeric(subtotalLine);
    }

    // 5. Lot Number (Line 0 or Line 7)
    let lotNumber: number | null = null;
    const lotLine = block.find(l => /^\d{3,5}$/.test(l.trim()));
    if (lotLine) lotNumber = parseInt(lotLine.trim(), 10);

    const result: RawParsedRow = {
      chassis,
      bid,
      total,
      date: dateStr,
      auction: 'USS',
      area: null, // To be filled by mapper or dispatcher
      lotNumber,
      recycle,
      jidosha,
      auctionFee: null,
      confidence: 0,
      flags,
    };

    result.confidence = this.calculateConfidence(result);
    return result;
  }
}
