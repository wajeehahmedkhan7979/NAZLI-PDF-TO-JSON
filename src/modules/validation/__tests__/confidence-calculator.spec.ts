import { ConfidenceCalculator } from '../../../modules/validation/confidence-calculator';

describe('ConfidenceCalculator', () => {
  let calc: ConfidenceCalculator;

  beforeEach(() => {
    calc = new ConfidenceCalculator();
  });

  it('produces correct weighted confidence', () => {
    const result = calc.calculate({
      ocrConfidence: 0.9,
      translationConfidence: 0.85,
      structuralConfidence: 0.8,
      mappingConfidence: 0.95,
    });
    // 0.9×0.30 + 0.85×0.25 + 0.8×0.25 + 0.95×0.20 = 0.27 + 0.2125 + 0.20 + 0.19 = 0.8725
    expect(result.overall).toBeCloseTo(0.8725, 2);
  });

  it('clamps to [0, 1]', () => {
    const result = calc.calculate({
      ocrConfidence: 1.5,
      translationConfidence: 1.0,
      structuralConfidence: 1.0,
      mappingConfidence: 1.0,
    });
    expect(result.overall).toBeLessThanOrEqual(1.0);
  });

  it('reports COMPLETED for high confidence', () => {
    expect(calc.qualityStatus(0.85)).toBe('COMPLETED');
    expect(calc.qualityStatus(0.70)).toBe('COMPLETED');
  });

  it('reports NEEDS_REVIEW for mid confidence', () => {
    expect(calc.qualityStatus(0.69)).toBe('NEEDS_REVIEW');
    expect(calc.qualityStatus(0.40)).toBe('NEEDS_REVIEW');
  });

  it('reports FAILED for low confidence', () => {
    expect(calc.qualityStatus(0.39)).toBe('FAILED');
    expect(calc.qualityStatus(0)).toBe('FAILED');
  });

  it('computes document-level confidence as mean of fields', () => {
    const breakdowns = [
      calc.calculate({ ocrConfidence: 0.9, translationConfidence: 0.9, structuralConfidence: 0.9, mappingConfidence: 0.9 }),
      calc.calculate({ ocrConfidence: 0.5, translationConfidence: 0.5, structuralConfidence: 0.5, mappingConfidence: 0.5 }),
    ];
    const docConf = calc.documentConfidence(breakdowns);
    // Document overall should be between the two values
    expect(docConf).toBeGreaterThan(0.5);
    expect(docConf).toBeLessThan(0.9);
  });

  it('returns 0 for empty breakdown list', () => {
    expect(calc.documentConfidence([])).toBe(0);
  });

  it('carries through all input dimensions', () => {
    const inputs = { ocrConfidence: 0.7, translationConfidence: 0.6, structuralConfidence: 0.8, mappingConfidence: 0.75 };
    const result = calc.calculate(inputs);
    expect(result.ocr).toBe(0.7);
    expect(result.translation).toBe(0.6);
    expect(result.structural).toBe(0.8);
    expect(result.mapping).toBe(0.75);
  });
});
