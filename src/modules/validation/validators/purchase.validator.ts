import { Injectable, Logger } from '@nestjs/common';

/**
 * PurchaseValidator — validates purchase document canonical output.
 *
 * Checks:
 * - VIN format: 17 chars or Japanese chassis [A-Z0-9]+-\d+
 * - Required fields: chassis, at least one price, buyer or seller
 * - Cross-check: total ≈ sum of components (within 1% tolerance)
 */

export interface ValidationError {
  field: string;
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

@Injectable()
export class PurchaseValidator {
  private readonly logger = new Logger(PurchaseValidator.name);

  validate(canonical: any): ValidationError[] {
    const errors: ValidationError[] = [];

    // ── Required fields ──────────────────────────────────────
    const chassis = canonical.vehicle?.chassis;
    const vin = canonical.vehicle?.vin;

    if (!chassis && !vin) {
      errors.push({
        field: 'vehicle.chassis',
        rule: 'required',
        message: 'Vehicle identifier (VIN or chassis) is required',
        severity: 'error',
      });
    }

    // ── VIN format ───────────────────────────────────────────
    if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
      errors.push({
        field: 'vehicle.vin',
        rule: 'format',
        message: `Invalid VIN format: ${vin} (expected 17 alphanumeric chars)`,
        severity: 'error',
      });
    }

    // ── Chassis format ───────────────────────────────────────
    if (chassis && !/^[A-Z][A-Z0-9]*-\d{4,}$/.test(chassis)) {
      errors.push({
        field: 'vehicle.chassis',
        rule: 'format',
        message: `Unusual chassis format: ${chassis}`,
        severity: 'warning',
      });
    }

    // ── At least one price ───────────────────────────────────
    const pricing = canonical.pricing || {};
    const hasPrice = pricing.total || pricing.subtotal || pricing.auctionFee;
    if (!hasPrice) {
      errors.push({
        field: 'pricing',
        rule: 'required',
        message: 'At least one price field is required',
        severity: 'error',
      });
    }

    // ── Buyer or seller ──────────────────────────────────────
    const parties = canonical.parties || {};
    if (!parties.buyer && !parties.seller) {
      errors.push({
        field: 'parties',
        rule: 'required',
        message: 'At least buyer or seller is required',
        severity: 'warning',
      });
    }

    // ── Price cross-check (total ≈ sum of parts) ─────────────
    if (pricing.total && pricing.subtotal) {
      const expectedTotal = (pricing.subtotal || 0) + (pricing.tax || 0);
      if (expectedTotal > 0) {
        const diff = Math.abs(pricing.total - expectedTotal);
        const tolerance = pricing.total * 0.01; // 1%
        if (diff > tolerance) {
          errors.push({
            field: 'pricing.total',
            rule: 'cross_check',
            message: `Total (${pricing.total}) doesn't match subtotal+tax (${expectedTotal}). Diff: ${diff}`,
            severity: 'warning',
          });
        }
      }
    }

    // ── Date sanity ──────────────────────────────────────────
    if (canonical.dates?.purchaseDate) {
      const date = new Date(canonical.dates.purchaseDate);
      if (isNaN(date.getTime())) {
        errors.push({
          field: 'dates.purchaseDate',
          rule: 'format',
          message: `Invalid date: ${canonical.dates.purchaseDate}`,
          severity: 'error',
        });
      } else {
        const year = date.getFullYear();
        if (year < 2000 || year > 2030) {
          errors.push({
            field: 'dates.purchaseDate',
            rule: 'range',
            message: `Unusual date year: ${year}`,
            severity: 'warning',
          });
        }
      }
    }

    return errors;
  }
}
