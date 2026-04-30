import { Injectable, Logger } from '@nestjs/common';
import { ParsedAuctionRow } from './auction-parser';
import { PurchaseRecord } from '../../common/schemas/purchase.schema';

/**
 * Column Mapper — Maps parsed fields to the final PurchaseRecord schema.
 *
 * Responsibilities:
 * - Date normalization (MM/DD → ISO 8601)
 * - Area translation (Japanese → English, dictionary only)
 * - Year inference from document date
 * - Numeric type coercion
 */
@Injectable()
export class ColumnMapper {
  private readonly logger = new Logger(ColumnMapper.name);

  // Area dictionary (deterministic, no LLM)
  private readonly AREA_MAP: Record<string, string> = {
    '横浜': 'Yokohama',
    '兵庫': 'Hyogo',
    '東京': 'Tokyo',
    '名古屋': 'Nagoya',
    '大阪': 'Osaka',
    '福岡': 'Fukuoka',
    '札幌': 'Sapporo',
    '仙台': 'Sendai',
    '広島': 'Hiroshima',
    '北海道': 'Hokkaido',
    '静岡': 'Shizuoka',
    '新潟': 'Niigata',
    '岡山': 'Okayama',
    '群馬': 'Gunma',
    '千葉': 'Chiba',
    '埼玉': 'Saitama',
    '京都': 'Kyoto',
    '神戸': 'Kobe',
  };

  /**
   * Map a parsed row to the final schema.
   * @param parsed The parsed auction row
   * @param documentYear The year from the document header (fallback: current year)
   */
  mapRow(parsed: ParsedAuctionRow, documentYear: number): PurchaseRecord {
    // ─── Date normalization ──────────────────────────────────
    let isoDate = '';
    if (parsed.date) {
      const [month, day] = parsed.date.split('/').map(Number);
      isoDate = `${documentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    // ─── Auction platform cleanup ──────────────────────────────
    let auction = parsed.auctionPlatform || '';
    if (auction.startsWith('TC-web')) auction = 'TC-web';
    if (auction.startsWith('ANS')) auction = 'ANS';
    if (auction.startsWith('USS')) auction = 'USS';

    // ─── Build output ────────────────────────────────────────
    return {
      date: isoDate,
      auction: auction,
      area: parsed.auctionLocation ? (this.AREA_MAP[parsed.auctionLocation] || parsed.auctionLocation) : '',
      lotNumber: parsed.lotNumber ?? undefined,
      year: documentYear,
      chassis: parsed.chassis || '',
      bid: parsed.startingPrice || 0,
      recycle: parsed.recycle ?? undefined,
      jidosha: parsed.jidosha ?? undefined,
      auctionFee: parsed.auctionFee ?? undefined,
      total: parsed.finalPrice || 0,
      confidence: parsed.confidence,
      flags: parsed.flags,
    };
  }
}
