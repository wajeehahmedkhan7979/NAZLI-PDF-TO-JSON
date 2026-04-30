import { Injectable, Logger } from '@nestjs/common';

/**
 * EvaluationResult — output of evaluating a single document against ground truth.
 */
export interface FieldError {
  field: string;
  expected: any;
  actual: any;
  errorType: 'missing' | 'wrong_value' | 'type_mismatch' | 'tolerance_exceeded';
  tolerancePct?: number;
}

export interface StageBreakdown {
  extraction: number;
  understanding: number;
  segmentation: number;
  translation: number;
  mapping: number;
  validation: number;
}

export interface EvaluationResult {
  sampleId: string;
  documentId: string;
  documentType: string;
  /** Overall accuracy: correct_fields / total_fields */
  accuracy: number;
  /** Number of fields evaluated */
  totalFields: number;
  /** Number of correct fields */
  correctFields: number;
  /** Per-field errors */
  fieldErrors: FieldError[];
  /** Per-stage confidence scores (from pipeline output) */
  stageBreakdown: StageBreakdown;
  /** Field-level accuracy map */
  fieldLevelAccuracy: Record<string, number>;
  /** Duration of evaluation in ms */
  durationMs: number;
  /** Timestamp */
  evaluatedAt: string;
}

export interface GroundTruth {
  _meta: {
    document_type: string;
    sample_id: string;
    pdf_file: string;
    notes?: string;
  };
  fields: Record<string, any>;
  /** Optional per-field numeric tolerance (0.01 = 1%) */
  tolerances?: Record<string, number>;
}

export interface PipelineOutput {
  /** Canonical JSON output from schema mapper */
  canonicalJson: Record<string, any>;
  /** Per-stage confidence scores */
  stageConfidences: Partial<StageBreakdown>;
  /** Document type detected */
  documentType: string;
}

/**
 * EvaluationService — dataset-driven accuracy evaluation.
 *
 * Compares pipeline output against ground-truth expected JSON.
 * Produces structured accuracy report with field-level breakdown.
 *
 * Usage:
 *   const result = evaluationService.evaluate(sampleId, groundTruth, pipelineOutput);
 */
@Injectable()
export class EvaluationService {
  private readonly logger = new Logger(EvaluationService.name);

  /** Running accuracy history for aggregate reporting */
  private history: EvaluationResult[] = [];

  /**
   * Evaluate a pipeline output against ground truth.
   */
  evaluate(
    documentId: string,
    groundTruth: GroundTruth,
    pipelineOutput: PipelineOutput,
  ): EvaluationResult {
    const startMs = Date.now();
    const sampleId = groundTruth._meta.sample_id;
    const fields = groundTruth.fields;
    const tolerances = groundTruth.tolerances || {};

    const fieldErrors: FieldError[] = [];
    const fieldResults: Record<string, boolean> = {};

    // ── Evaluate each expected field ─────────────────────────
    for (const [field, expectedRaw] of Object.entries(fields)) {
      if (expectedRaw === null) {
        // null means "not expected in this doc type" — skip
        continue;
      }

      const actual = this.extractField(pipelineOutput.canonicalJson, field);
      const tolerance = tolerances[field] ?? 0;

      const { correct, error } = this.compareField(field, expectedRaw, actual, tolerance);
      fieldResults[field] = correct;

      if (error) {
        fieldErrors.push(error);
      }
    }

    const totalFields = Object.keys(fieldResults).length;
    const correctFields = Object.values(fieldResults).filter(Boolean).length;
    const accuracy = totalFields > 0 ? correctFields / totalFields : 0;

    // ── Build field-level accuracy ────────────────────────────
    const fieldLevelAccuracy: Record<string, number> = {};
    for (const [field, correct] of Object.entries(fieldResults)) {
      fieldLevelAccuracy[field] = correct ? 1.0 : 0.0;
    }

    // ── Stage breakdown from pipeline ─────────────────────────
    const stageBreakdown: StageBreakdown = {
      extraction: pipelineOutput.stageConfidences.extraction ?? 0,
      understanding: pipelineOutput.stageConfidences.understanding ?? 0,
      segmentation: pipelineOutput.stageConfidences.segmentation ?? 1.0,
      translation: pipelineOutput.stageConfidences.translation ?? 0,
      mapping: pipelineOutput.stageConfidences.mapping ?? 0,
      validation: pipelineOutput.stageConfidences.validation ?? 0,
    };

    const result: EvaluationResult = {
      sampleId,
      documentId,
      documentType: groundTruth._meta.document_type,
      accuracy: parseFloat(accuracy.toFixed(4)),
      totalFields,
      correctFields,
      fieldErrors,
      stageBreakdown,
      fieldLevelAccuracy,
      durationMs: Date.now() - startMs,
      evaluatedAt: new Date().toISOString(),
    };

    // Store in history
    this.history.push(result);

    this.logger.log(
      `[${sampleId}] accuracy=${(accuracy * 100).toFixed(1)}% ` +
        `(${correctFields}/${totalFields} fields), ` +
        `errors=[${fieldErrors.map((e) => e.field).join(', ')}]`,
    );

    if (fieldErrors.length > 0) {
      for (const err of fieldErrors) {
        this.logger.warn(
          `  [${err.field}] expected=${JSON.stringify(err.expected)} ` +
            `actual=${JSON.stringify(err.actual)} (${err.errorType})`,
        );
      }
    }

    return result;
  }

  /**
   * Aggregate accuracy across all evaluated samples.
   */
  aggregateReport(): {
    totalSamples: number;
    avgAccuracy: number;
    fieldAccuracy: Record<string, number>;
    byDocType: Record<string, { count: number; avgAccuracy: number }>;
  } {
    if (this.history.length === 0) {
      return { totalSamples: 0, avgAccuracy: 0, fieldAccuracy: {}, byDocType: {} };
    }

    const avgAccuracy =
      this.history.reduce((s, r) => s + r.accuracy, 0) / this.history.length;

    // Field accuracy across all samples
    const fieldCounts: Record<string, { correct: number; total: number }> = {};
    for (const r of this.history) {
      for (const [field, acc] of Object.entries(r.fieldLevelAccuracy)) {
        if (!fieldCounts[field]) fieldCounts[field] = { correct: 0, total: 0 };
        fieldCounts[field].total++;
        if (acc === 1.0) fieldCounts[field].correct++;
      }
    }

    const fieldAccuracy: Record<string, number> = {};
    for (const [field, { correct, total }] of Object.entries(fieldCounts)) {
      fieldAccuracy[field] = parseFloat((correct / total).toFixed(3));
    }

    // By doc type
    const byDocType: Record<string, { count: number; avgAccuracy: number }> = {};
    for (const r of this.history) {
      if (!byDocType[r.documentType]) byDocType[r.documentType] = { count: 0, avgAccuracy: 0 };
      byDocType[r.documentType].count++;
      byDocType[r.documentType].avgAccuracy += r.accuracy;
    }
    for (const type of Object.keys(byDocType)) {
      byDocType[type].avgAccuracy = parseFloat(
        (byDocType[type].avgAccuracy / byDocType[type].count).toFixed(3),
      );
    }

    return {
      totalSamples: this.history.length,
      avgAccuracy: parseFloat(avgAccuracy.toFixed(4)),
      fieldAccuracy,
      byDocType,
    };
  }

  clearHistory(): void {
    this.history = [];
  }

  // ── Private helpers ─────────────────────────────────────────

  private extractField(json: Record<string, any>, field: string): any {
    // Support dot-notation: "vehicle.chassis"
    const parts = field.split('.');
    let current: any = json;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }

  private compareField(
    field: string,
    expected: any,
    actual: any,
    tolerance: number,
  ): { correct: boolean; error: FieldError | null } {
    // Missing value
    if (actual === undefined || actual === null) {
      return {
        correct: false,
        error: { field, expected, actual, errorType: 'missing' },
      };
    }

    // Numeric comparison with tolerance
    if (typeof expected === 'number' && typeof actual === 'number') {
      const diff = Math.abs(expected - actual);
      const pct = expected !== 0 ? diff / Math.abs(expected) : diff;
      if (tolerance > 0 && pct <= tolerance) {
        return { correct: true, error: null };
      }
      if (diff === 0) return { correct: true, error: null };
      return {
        correct: false,
        error: {
          field,
          expected,
          actual,
          errorType: tolerance > 0 ? 'tolerance_exceeded' : 'wrong_value',
          tolerancePct: parseFloat((pct * 100).toFixed(2)),
        },
      };
    }

    // String comparison (normalize: trim, lowercase)
    if (typeof expected === 'string' && typeof actual === 'string') {
      const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
      if (norm(expected) === norm(actual)) return { correct: true, error: null };
      return {
        correct: false,
        error: { field, expected, actual, errorType: 'wrong_value' },
      };
    }

    // Type mismatch
    if (typeof expected !== typeof actual) {
      return {
        correct: false,
        error: { field, expected, actual, errorType: 'type_mismatch' },
      };
    }

    // Generic equality
    const correct = JSON.stringify(expected) === JSON.stringify(actual);
    return {
      correct,
      error: correct ? null : { field, expected, actual, errorType: 'wrong_value' },
    };
  }
}
