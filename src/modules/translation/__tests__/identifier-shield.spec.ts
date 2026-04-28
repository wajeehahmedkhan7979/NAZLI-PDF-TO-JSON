import { IdentifierShield } from '../../../modules/translation/identifier-shield';

describe('IdentifierShield', () => {
  let shield: IdentifierShield;

  beforeEach(() => {
    shield = new IdentifierShield();
  });

  describe('shield()', () => {
    it('shields a VIN', () => {
      const result = shield.shield('VIN: JN1TANS61Z0123456');
      expect(result.shieldedText).not.toContain('JN1TANS61Z0123456');
      expect(result.identifiedItems).toHaveLength(1);
      expect(result.identifiedItems[0].type).toBe('VIN');
      expect(result.identifiedItems[0].original).toBe('JN1TANS61Z0123456');
    });

    it('shields a Japanese chassis number', () => {
      const result = shield.shield('車台番号: KSP210-0116561');
      expect(result.shieldedText).not.toContain('KSP210-0116561');
      expect(result.identifiedItems.some((i) => i.type === 'CHASSIS')).toBe(true);
    });

    it('shields an era date', () => {
      const result = shield.shield('令和5年12月25日に発行');
      expect(result.shieldedText).not.toContain('令和5年12月25日');
      expect(result.identifiedItems.some((i) => i.type === 'DATE_ERA')).toBe(true);
    });

    it('shields currency amounts', () => {
      const result = shield.shield('合計: ¥1,234,567');
      expect(result.shieldedText).not.toContain('¥1,234,567');
      expect(result.identifiedItems.some((i) => i.type === 'CURRENCY')).toBe(true);
    });

    it('shields postal code', () => {
      const result = shield.shield('〒160-0023 東京都');
      expect(result.shieldedText).not.toContain('〒160-0023');
      expect(result.identifiedItems.some((i) => i.type === 'POSTAL_CODE')).toBe(true);
    });

    it('shields phone number', () => {
      const result = shield.shield('TEL: 03-1234-5678');
      expect(result.shieldedText).not.toContain('03-1234-5678');
      expect(result.identifiedItems.some((i) => i.type === 'PHONE')).toBe(true);
    });

    it('does not produce overlapping sentinels', () => {
      const text = 'KSP210-0116561 と VIN JN1TANS61Z0123456 があります';
      const result = shield.shield(text);
      // Neither should remain in shielded text
      expect(result.shieldedText).not.toContain('KSP210-0116561');
      expect(result.shieldedText).not.toContain('JN1TANS61Z0123456');
      // Sentinels should not overlap
      const sentinelMatches = result.shieldedText.match(/__ID_[a-f0-9]+_[a-z_]+__/g) || [];
      expect(new Set(sentinelMatches).size).toBe(sentinelMatches.length);
    });

    it('returns empty identifiedItems for plain text', () => {
      const result = shield.shield('これは普通のテキストです');
      expect(result.identifiedItems).toHaveLength(0);
      expect(result.shieldedText).toBe('これは普通のテキストです');
    });
  });

  describe('unshield()', () => {
    it('restores shielded identifiers', () => {
      const original = 'チェーシス: KSP210-0116561 合計: ¥500,000';
      const shielded = shield.shield(original);
      const restored = shield.unshield(shielded.shieldedText, shielded.tokens);
      expect(restored).toContain('KSP210-0116561');
      expect(restored).toContain('¥500,000');
    });

    it('full round-trip: shield → simulate translation → unshield', () => {
      const text = '車台番号: KSP210-0116561 発行日: 2024-03-15';
      const shielded = shield.shield(text);

      // Simulate translation (replace Japanese labels, preserve sentinels)
      const translated = shielded.shieldedText
        .replace('車台番号', 'Chassis Number')
        .replace('発行日', 'Issue Date');

      const restored = shield.unshield(translated, shielded.tokens);
      expect(restored).toContain('Chassis Number');
      expect(restored).toContain('Issue Date');
      expect(restored).toContain('KSP210-0116561');
      expect(restored).toContain('2024-03-15');
      // Sentinels must be gone
      expect(restored).not.toMatch(/__ID_[a-f0-9]+_[a-z_]+__/);
    });

    it('handles missing tokens gracefully', () => {
      const restored = shield.unshield('Hello world', new Map());
      expect(restored).toBe('Hello world');
    });
  });
});
