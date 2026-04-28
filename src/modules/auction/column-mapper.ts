import { Injectable, Logger } from '@nestjs/common';
import { ParsedAuctionRow } from './auction-parser';
import { AuctionRow } from '../../common/schemas/auction.schema';

/**
 * Column Mapper — Maps parsed fields to the final AuctionRow schema.
 *
 * Responsibilities:
 * - Date normalization (MM/DD → ISO 8601)
 * - Area translation (Japanese → English, dictionary only)
 * - Car name transliteration (katakana → romaji, best effort)
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

  // Common katakana car name → English mapping
  private readonly CAR_NAME_MAP: Record<string, string> = {
    'ﾔﾘｽ': 'Yaris',
    'ｶﾛｰﾗ': 'Corolla',
    'ｶﾛｰﾗｱｸｼｵ': 'Corolla Axio',
    'ｶﾛｰﾗﾌｨｰﾙﾀﾞｰ': 'Corolla Fielder',
    'ﾉｱ': 'Noah',
    'ｳﾞｪｾﾞﾙ': 'Vezel',
    'ﾜｺﾞﾝR': 'Wagon R',
    'ﾗｲｽﾞ': 'Raize',
    'ﾙｰﾐｰ': 'Roomy',
    'ｼｴﾝﾀ': 'Sienta',
    'ﾌﾟﾘｳｽ': 'Prius',
    'ｱｸｱ': 'Aqua',
    'ﾌﾟﾚﾐｵ': 'Premio',
    'ﾊﾘｱｰ': 'Harrier',
    'ﾗﾝﾄﾞｸﾙｰｻﾞｰ': 'Land Cruiser',
    'ﾊｲｴｰｽ': 'HiAce',
    'ｱﾙﾌｧｰﾄﾞ': 'Alphard',
    'ｳﾞｫｸｼｰ': 'Voxy',
    'ﾌｨｯﾄ': 'Fit',
    'ｽﾃｯﾌﾟﾜｺﾞﾝ': 'Stepwgn',
    'ﾀﾝﾄ': 'Tanto',
    'ﾑｰﾌﾞ': 'Move',
    'ﾃﾞｲｽﾞ': 'Dayz',
    'ｽﾍﾟｰｼｱ': 'Spacia',
    'ﾊｽﾗｰ': 'Hustler',
  };

  /**
   * Map a parsed row to the final schema.
   * @param parsed The parsed auction row
   * @param documentYear The year from the document header (fallback: current year)
   */
  mapRow(parsed: ParsedAuctionRow, documentYear: number): AuctionRow {
    // ─── Date normalization ──────────────────────────────────
    let isoDate = '';
    if (parsed.date) {
      const [month, day] = parsed.date.split('/').map(Number);
      isoDate = `${documentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    // ─── Area translation ────────────────────────────────────
    // ─── Auction platform cleanup ──────────────────────────────
    let auction = parsed.auctionPlatform || '';
    if (auction.startsWith('TC-web')) auction = 'TC-web';
    if (auction.startsWith('ANS')) auction = 'ANS';
    if (auction.startsWith('USS')) auction = 'USS';

    // ─── Car name transliteration ────────────────────────────
    let carName = parsed.carName || '';
    carName = this.normalizeHalfWidth(carName);
    
    // Try to match known car name patterns
    for (const [katakana, english] of Object.entries(this.CAR_NAME_MAP)) {
      if (carName.includes(katakana)) {
        carName = carName.replace(katakana, english);
      }
    }
    // Clean up common suffixes
    carName = carName
      .replace('ﾊｲﾌﾞﾘｯﾄﾞ', 'Hybrid')
      .replace('ｶｽﾀﾑ', 'Custom')
      .replace('ﾊﾟｯｹｰｼﾞ', 'Package')
      .trim();

    // ─── Build output ────────────────────────────────────────
    return {
      date: isoDate,
      auctionPlatform: auction,
      auctionLocation: parsed.auctionLocation ? (this.AREA_MAP[parsed.auctionLocation] || parsed.auctionLocation) : '',
      lotNumber: parsed.lotNumber ?? undefined,
      year: documentYear,
      chassis: parsed.chassis || '',
      carName: carName || undefined,
      startingPrice: parsed.startingPrice ?? undefined,
      recycle: parsed.recycle ?? undefined,
      jidosha: parsed.jidosha ?? undefined,
      auctionFee: parsed.auctionFee ?? undefined,
      finalPrice: parsed.finalPrice || 0,
      confidence: parsed.confidence,
      flags: parsed.flags.length > 0 ? parsed.flags : undefined,
      rawBlock: parsed.flags.length > 0 ? parsed.rawBlock : undefined,
    };
  }

  /**
   * Normalize full-width Katakana to half-width equivalents where possible
   * to maximize dictionary hit rate and consistency.
   */
  private normalizeHalfWidth(str: string): string {
    return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(s) {
      return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    });
  }
}
