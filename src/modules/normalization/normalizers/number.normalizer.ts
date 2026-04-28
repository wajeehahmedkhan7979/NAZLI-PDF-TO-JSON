import { Injectable } from '@nestjs/common';

@Injectable()
export class NumberNormalizer {
  normalize(text: string): number | null {
    if (!text) return null;

    // Remove commas and currency symbols
    let cleaned = text.replace(/,/g, '').replace(/[¥$€]/g, '').trim();

    // Map basic kanji numerals (Simplified example)
    const kanjiMap: Record<string, string> = {
      '一': '1', '二': '2', '三': '3', '四': '4', '五': '5',
      '六': '6', '七': '7', '八': '8', '九': '9', '〇': '0'
    };

    let hasKanji = false;
    for (const [k, v] of Object.entries(kanjiMap)) {
      if (cleaned.includes(k)) {
        cleaned = cleaned.replace(new RegExp(k, 'g'), v);
        hasKanji = true;
      }
    }

    // Handles '万' modifier very naively
    if (cleaned.includes('万')) {
       cleaned = cleaned.replace('万', '');
       const val = parseFloat(cleaned);
       if (!isNaN(val)) return val * 10000;
    }

    const val = parseFloat(cleaned);
    return isNaN(val) ? null : val;
  }
}
