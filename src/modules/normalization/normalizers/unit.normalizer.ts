import { Injectable } from '@nestjs/common';

@Injectable()
export class UnitNormalizer {
  // Mapping rules 
  private unitMap: Record<string, string> = {
    '個': 'pcs',
    '本': 'pcs',
    '枚': 'pcs',
    'セット': 'set',
    '箱': 'box',
    '円': 'JPY',
    'ドル': 'USD',
  };

  normalize(japaneseUnit: string): string {
    if (!japaneseUnit) return '';
    const clean = japaneseUnit.trim();
    return this.unitMap[clean] || clean;
  }
}
