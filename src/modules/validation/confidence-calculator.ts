import { Injectable, Logger } from '@nestjs/common';

/**
 * ConfidenceCalculator — weighted multi-source confidence propagation.
 *
 * field_confidence = weighted(
 *   ocr_confidence,          // 0.30 — from Marker per-line
 *   translation_confidence,  // 0.25 — from tier used
 *   structural_confidence,   // 0.25 — from table reconstruction
 *   mapping_confidence       // 0.20 — from schema match certainty
 * )
 */

export interface ConfidenceInputs {
  ocrConfidence: number;
  translationConfidence: number;
  structuralConfidence: number;
  mappingConfidence: number;
}

export interface ConfidenceBreakdown {
  overall: number;
  ocr: number;
  translation: number;
  structural: number;
  mapping: number;
  weights: typeof ConfidenceCalculator.WEIGHTS;
}

@Injectable()
export class ConfidenceCalculator {
  private readonly logger = new Logger(ConfidenceCalculator.name);

  static readonly WEIGHTS = {
    ocr: 0.30,
    translation: 0.25,
    structural: 0.25,
    mapping: 0.20,
  };

  /**
   * Calculate weighted confidence for a single field.
   */
  calculate(inputs: ConfidenceInputs): ConfidenceBreakdown {
    const w = ConfidenceCalculator.WEIGHTS;

    const overall =
      inputs.ocrConfidence * w.ocr +
      inputs.translationConfidence * w.translation +
      inputs.structuralConfidence * w.structural +
      inputs.mappingConfidence * w.mapping;

    return {
      overall: parseFloat(Math.min(1, Math.max(0, overall)).toFixed(3)),
      ocr: inputs.ocrConfidence,
      translation: inputs.translationConfidence,
      structural: inputs.structuralConfidence,
      mapping: inputs.mappingConfidence,
      weights: w,
    };
  }

  /**
   * Calculate document-level confidence from field-level breakdowns.
   */
  documentConfidence(fieldBreakdowns: ConfidenceBreakdown[]): number {
    if (fieldBreakdowns.length === 0) return 0;
    const sum = fieldBreakdowns.reduce((acc, b) => acc + b.overall, 0);
    return parseFloat((sum / fieldBreakdowns.length).toFixed(3));
  }

  /**
   * Determine quality status from confidence score.
   */
  qualityStatus(confidence: number): 'COMPLETED' | 'NEEDS_REVIEW' | 'FAILED' {
    if (confidence >= 0.7) return 'COMPLETED';
    if (confidence >= 0.4) return 'NEEDS_REVIEW';
    return 'FAILED';
  }
}
