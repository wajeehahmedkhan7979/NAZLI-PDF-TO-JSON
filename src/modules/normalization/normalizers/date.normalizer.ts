import { Injectable } from '@nestjs/common';

@Injectable()
export class DateNormalizer {
  // Returns ISO 8601 string (YYYY-MM-DD)
  normalize(japaneseDate: string): string | null {
    if (!japaneseDate) return null;

    // Extremely simplified example for agent constraints. 
    // In production, use date-fns or a robust JP parser to handle Reiwa/Heisei etc.
    
    // Pattern 1: YYYY/MM/DD or YYYY-MM-DD
    const isoMatch = japaneseDate.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})日?/);
    if (isoMatch) {
      const year = isoMatch[1];
      const month = isoMatch[2].padStart(2, '0');
      const day = isoMatch[3].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    // Pattern 2: Reiwa fallback (令和8年 = 2026)
    const reiwaMatch = japaneseDate.match(/令和(\d+)年(\d+)月(\d+)日/);
    if (reiwaMatch) {
      const year = 2018 + parseInt(reiwaMatch[1], 10);
      const month = reiwaMatch[2].padStart(2, '0');
      const day = reiwaMatch[3].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    return null; // Invalid/unknown
  }
}
