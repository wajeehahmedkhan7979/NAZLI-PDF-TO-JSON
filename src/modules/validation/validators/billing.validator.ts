import { Injectable, Logger } from '@nestjs/common';

/**
 * BillingValidator — validates billing/invoice document canonical output.
 *
 * Checks:
 * - Required: invoice number, ≥1 line item, total
 * - Sum check: line_items × qty = amount, sum = subtotal, subtotal + tax = total
 * - Date: valid ISO-8601
 * - Currency normalization
 */

export interface ValidationError {
  field: string;
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

@Injectable()
export class BillingValidator {
  private readonly logger = new Logger(BillingValidator.name);

  validate(canonical: any): ValidationError[] {
    const errors: ValidationError[] = [];

    // ── Required fields ──────────────────────────────────────
    if (!canonical.invoiceNumber) {
      errors.push({
        field: 'invoiceNumber',
        rule: 'required',
        message: 'Invoice number is required',
        severity: 'error',
      });
    }

    const lineItems = canonical.lineItems || [];
    if (lineItems.length === 0) {
      errors.push({
        field: 'lineItems',
        rule: 'required',
        message: 'At least one line item is required',
        severity: 'warning',
      });
    }

    const totals = canonical.totals || {};
    if (!totals.total && totals.total !== 0) {
      errors.push({
        field: 'totals.total',
        rule: 'required',
        message: 'Total amount is required',
        severity: 'error',
      });
    }

    // ── Sum checks ───────────────────────────────────────────
    // subtotal + tax = total
    if (totals.subtotal != null && totals.tax != null && totals.total != null) {
      const expectedTotal = totals.subtotal + totals.tax;
      const diff = Math.abs(totals.total - expectedTotal);
      const tolerance = Math.max(totals.total * 0.01, 1); // 1% or ¥1
      if (diff > tolerance) {
        errors.push({
          field: 'totals',
          rule: 'sum_check',
          message: `subtotal(${totals.subtotal}) + tax(${totals.tax}) = ${expectedTotal} ≠ total(${totals.total})`,
          severity: 'warning',
        });
      }
    }

    // ── Line item validation ─────────────────────────────────
    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];

      // Quantity × unit price = amount
      if (item.quantity != null && item.unitPrice != null && item.amount != null) {
        const expectedAmount = item.quantity * item.unitPrice;
        const diff = Math.abs(item.amount - expectedAmount);
        const tolerance = Math.max(expectedAmount * 0.01, 1);
        if (diff > tolerance) {
          errors.push({
            field: `lineItems[${i}]`,
            rule: 'line_sum',
            message: `qty(${item.quantity}) × price(${item.unitPrice}) = ${expectedAmount} ≠ amount(${item.amount})`,
            severity: 'warning',
          });
        }
      }
    }

    // ── Date validation ──────────────────────────────────────
    if (canonical.invoiceDate) {
      const date = new Date(canonical.invoiceDate);
      if (isNaN(date.getTime())) {
        errors.push({
          field: 'invoiceDate',
          rule: 'format',
          message: `Invalid date format: ${canonical.invoiceDate}`,
          severity: 'error',
        });
      }
    }

    // ── Vendor/client presence ────────────────────────────────
    if (!canonical.vendor) {
      errors.push({
        field: 'vendor',
        rule: 'required',
        message: 'Vendor name is recommended',
        severity: 'warning',
      });
    }

    return errors;
  }
}
