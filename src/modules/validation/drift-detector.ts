import { Injectable, Logger } from '@nestjs/common';

/**
 * DriftDetector — detects cross-stage value inconsistencies.
 *
 * The pipeline has multiple transformation stages:
 *   Extraction → Understanding → Translation → Mapping → Validation
 *
 * Drift occurs when a value changes unexpectedly across stages:
 *   - A numeric total extracted as 1,849,000 gets mapped as 1,949,000
 *   - A chassis number gets partially translated or corrupted
 *   - Subtotal + Tax ≠ Total (math drift)
 *
 * This detector runs as part of the validation stage and emits
 * structured drift events that feed into the quality gate.
 */

export type DriftType =
  | 'TOTAL_MISMATCH'         // mapped total ≠ extracted total
  | 'MATH_DRIFT'             // subtotal + tax ≠ total
  | 'IDENTIFIER_DRIFT'       // VIN/chassis changed across stages
  | 'VALUE_INCONSISTENCY'    // any numeric field changed unexpectedly
  | 'CURRENCY_SIGN_DROPPED'  // ¥ stripped from currency value
  | 'DATE_CORRUPTION'        // date format changed incorrectly
  | 'DOUBLE_TRANSLATION';    // identifier was translated when it shouldn't have been

export type DriftSeverity = 'critical' | 'warning' | 'info';

export interface DriftEvent {
  type: DriftType;
  severity: DriftSeverity;
  field: string;
  stageA: string;
  stageB: string;
  valueA: any;
  valueB: any;
  /** Percentage difference for numeric drift */
  diffPct?: number;
  description: string;
}

export interface DriftReport {
  documentId: string;
  hasCriticalDrift: boolean;
  driftCount: number;
  events: DriftEvent[];
  checkedAt: string;
}

@Injectable()
export class DriftDetector {
  private readonly logger = new Logger(DriftDetector.name);

  /** Numeric drift tolerance: 1% is acceptable (rounding, formatting) */
  private readonly NUMERIC_TOLERANCE = 0.01;

  /** Math balance tolerance: 0.5% for subtotal + tax = total */
  private readonly MATH_TOLERANCE = 0.005;

  /**
   * Run all drift checks and return a consolidated report.
   *
   * @param documentId - document being processed
   * @param extracted  - raw numeric/identifier values from extraction stage
   * @param mapped     - values after schema mapping
   * @param translated - text before and after translation (for identifier drift)
   */
  detect(
    documentId: string,
    extracted: ExtractedValues,
    mapped: MappedValues,
    translated?: TranslationSnapshot[],
  ): DriftReport {
    const events: DriftEvent[] = [];

    // 1. Total mismatch between extraction and mapping
    events.push(...this.checkTotalMismatch(extracted, mapped));

    // 2. Math consistency: subtotal + tax = total
    events.push(...this.checkMathBalance(mapped));

    // 3. Identifier integrity across stages
    events.push(...this.checkIdentifierDrift(extracted, mapped));

    // 4. Translation identifier leakage
    if (translated) {
      events.push(...this.checkTranslationDrift(translated));
    }

    // 5. General numeric field drift
    events.push(...this.checkNumericDrift(extracted, mapped));

    const hasCriticalDrift = events.some((e) => e.severity === 'critical');

    if (events.length > 0) {
      const criticalCount = events.filter((e) => e.severity === 'critical').length;
      this.logger.warn(
        `[${documentId}] Drift detected: ${events.length} events (${criticalCount} critical). ` +
          events.map((e) => `${e.type}(${e.field})`).join(', '),
      );
    } else {
      this.logger.debug(`[${documentId}] No drift detected`);
    }

    return {
      documentId,
      hasCriticalDrift,
      driftCount: events.length,
      events,
      checkedAt: new Date().toISOString(),
    };
  }

  // ── Drift Checks ─────────────────────────────────────────────

  private checkTotalMismatch(
    extracted: ExtractedValues,
    mapped: MappedValues,
  ): DriftEvent[] {
    const events: DriftEvent[] = [];
    const pairs: Array<[string, number | undefined, number | undefined]> = [
      ['total', extracted.total, mapped.total],
      ['subtotal', extracted.subtotal, mapped.subtotal],
      ['tax', extracted.tax, mapped.tax],
      ['auction_fee', extracted.auctionFee, mapped.auctionFee],
    ];

    for (const [field, extVal, mapVal] of pairs) {
      if (extVal == null || mapVal == null) continue;
      const diff = Math.abs(extVal - mapVal);
      const pct = extVal !== 0 ? diff / Math.abs(extVal) : diff;
      if (pct > this.NUMERIC_TOLERANCE) {
        events.push({
          type: 'TOTAL_MISMATCH',
          severity: pct > 0.05 ? 'critical' : 'warning',
          field,
          stageA: 'extraction',
          stageB: 'mapping',
          valueA: extVal,
          valueB: mapVal,
          diffPct: parseFloat((pct * 100).toFixed(2)),
          description: `${field} changed from ${extVal} → ${mapVal} (${(pct * 100).toFixed(1)}% drift)`,
        });
      }
    }

    return events;
  }

  private checkMathBalance(mapped: MappedValues): DriftEvent[] {
    const events: DriftEvent[] = [];
    const { total, subtotal, tax } = mapped;

    if (total != null && subtotal != null && tax != null) {
      const computed = subtotal + tax;
      const diff = Math.abs(total - computed);
      const pct = total !== 0 ? diff / Math.abs(total) : diff;

      if (pct > this.MATH_TOLERANCE) {
        events.push({
          type: 'MATH_DRIFT',
          severity: pct > 0.05 ? 'critical' : 'warning',
          field: 'total',
          stageA: 'mapping',
          stageB: 'mapping',
          valueA: total,
          valueB: computed,
          diffPct: parseFloat((pct * 100).toFixed(2)),
          description:
            `Math imbalance: subtotal(${subtotal}) + tax(${tax}) = ${computed} ≠ total(${total}) ` +
            `(${(pct * 100).toFixed(1)}% off)`,
        });
      }
    }

    return events;
  }

  private checkIdentifierDrift(
    extracted: ExtractedValues,
    mapped: MappedValues,
  ): DriftEvent[] {
    const events: DriftEvent[] = [];
    const pairs: Array<[string, string | undefined, string | undefined]> = [
      ['chassis', extracted.chassis, mapped.chassis],
      ['vin', extracted.vin, mapped.vin],
      ['invoice_number', extracted.invoiceNumber, mapped.invoiceNumber],
    ];

    for (const [field, extVal, mapVal] of pairs) {
      if (!extVal || !mapVal) continue;
      const normalize = (s: string) => s.trim().toUpperCase().replace(/[-\s]/g, '');
      if (normalize(extVal) !== normalize(mapVal)) {
        events.push({
          type: 'IDENTIFIER_DRIFT',
          severity: 'critical', // identifiers must never change
          field,
          stageA: 'extraction',
          stageB: 'mapping',
          valueA: extVal,
          valueB: mapVal,
          description: `Identifier ${field} changed: "${extVal}" → "${mapVal}"`,
        });
      }
    }

    return events;
  }

  private checkTranslationDrift(snapshots: TranslationSnapshot[]): DriftEvent[] {
    const events: DriftEvent[] = [];

    const identifierPattern = /[A-HJ-NPR-Z0-9]{17}|[A-Z][A-Z0-9]{2,}-\d{4,}/;

    for (const snap of snapshots) {
      if (!snap.original || !snap.translated) continue;

      // Check if identifier was present in original but not in translated
      const origHasId = identifierPattern.test(snap.original);
      const transHasId = identifierPattern.test(snap.translated);

      if (origHasId && !transHasId) {
        events.push({
          type: 'DOUBLE_TRANSLATION',
          severity: 'critical',
          field: snap.blockId,
          stageA: 'pre-translation',
          stageB: 'post-translation',
          valueA: snap.original,
          valueB: snap.translated,
          description: `Identifier may have been translated or corrupted in block ${snap.blockId}`,
        });
      }

      // Check numeric values weren't changed during translation
      const numPattern = /[\d,]{4,}/g;
      const origNums = (snap.original.match(numPattern) || []).map((n) =>
        parseInt(n.replace(/,/g, ''), 10),
      );
      const transNums = (snap.translated.match(numPattern) || []).map((n) =>
        parseInt(n.replace(/,/g, ''), 10),
      );

      if (origNums.length > 0 && transNums.length > 0) {
        const origSet = new Set(origNums);
        const transSet = new Set(transNums);
        const missing = origNums.filter((n) => !transSet.has(n));
        if (missing.length > 0) {
          events.push({
            type: 'VALUE_INCONSISTENCY',
            severity: 'warning',
            field: snap.blockId,
            stageA: 'pre-translation',
            stageB: 'post-translation',
            valueA: origNums,
            valueB: transNums,
            description: `Numbers missing after translation in block ${snap.blockId}: ${missing.join(', ')}`,
          });
        }
      }
    }

    return events;
  }

  private checkNumericDrift(
    extracted: ExtractedValues,
    mapped: MappedValues,
  ): DriftEvent[] {
    // Already handled in checkTotalMismatch for named fields.
    // This catches any raw_amounts that don't match.
    const events: DriftEvent[] = [];

    if (extracted.rawAmounts && mapped.rawAmounts) {
      const extSorted = [...extracted.rawAmounts].sort((a, b) => a - b);
      const mapSorted = [...mapped.rawAmounts].sort((a, b) => a - b);

      // Check if any large amounts from extraction disappeared in mapping
      for (const extAmt of extSorted) {
        if (extAmt < 1000) continue; // Skip small numbers (not financially significant)
        const found = mapSorted.some((m) => {
          const pct = Math.abs(m - extAmt) / extAmt;
          return pct <= this.NUMERIC_TOLERANCE;
        });
        if (!found) {
          events.push({
            type: 'VALUE_INCONSISTENCY',
            severity: 'warning',
            field: 'raw_amounts',
            stageA: 'extraction',
            stageB: 'mapping',
            valueA: extAmt,
            valueB: null,
            description: `Amount ${extAmt.toLocaleString()} from extraction not found in mapped output`,
          });
        }
      }
    }

    return events;
  }
}

// ── Value snapshots passed into DriftDetector ─────────────────

export interface ExtractedValues {
  total?: number;
  subtotal?: number;
  tax?: number;
  auctionFee?: number;
  chassis?: string;
  vin?: string;
  invoiceNumber?: string;
  rawAmounts?: number[];
}

export interface MappedValues {
  total?: number;
  subtotal?: number;
  tax?: number;
  auctionFee?: number;
  chassis?: string;
  vin?: string;
  invoiceNumber?: string;
  rawAmounts?: number[];
}

export interface TranslationSnapshot {
  blockId: string;
  original: string;
  translated: string;
}
