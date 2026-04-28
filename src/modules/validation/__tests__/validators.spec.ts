import { PurchaseValidator, ValidationError } from '../../../modules/validation/validators/purchase.validator';
import { BillingValidator } from '../../../modules/validation/validators/billing.validator';

describe('PurchaseValidator', () => {
  let validator: PurchaseValidator;

  beforeEach(() => {
    validator = new PurchaseValidator();
  });

  it('passes a valid purchase document', () => {
    const canonical = {
      vehicle: { chassis: 'KSP210-0116561', vin: null, modelCode: 'KSP210', name: 'Vitz' },
      parties: { buyer: 'NAZLI TRADING', seller: 'Toyota Japan' },
      pricing: { total: 1200000, subtotal: 1100000, tax: 100000 },
      dates: { purchaseDate: '2024-03-15' },
    };
    const errors = validator.validate(canonical);
    const hardErrors = errors.filter((e: ValidationError) => e.severity === 'error');
    expect(hardErrors).toHaveLength(0);
  });

  it('fails when no vehicle identifier provided', () => {
    const canonical = {
      vehicle: { chassis: null, vin: null },
      parties: { buyer: 'NAZLI', seller: 'Dealer' },
      pricing: { total: 500000 },
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e: ValidationError) => e.field === 'vehicle.chassis' && e.severity === 'error')).toBe(true);
  });

  it('rejects invalid VIN format', () => {
    const canonical = {
      vehicle: { vin: 'INVALID123', chassis: null },
      parties: { buyer: 'B', seller: 'S' },
      pricing: { total: 100000 },
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e: ValidationError) => e.field === 'vehicle.vin' && e.rule === 'format')).toBe(true);
  });

  it('accepts valid VIN format', () => {
    const canonical = {
      vehicle: { vin: 'JN1TANS61Z0123456', chassis: null },
      parties: { buyer: 'B', seller: 'S' },
      pricing: { total: 100000 },
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e: ValidationError) => e.field === 'vehicle.vin' && e.rule === 'format')).toBe(false);
  });

  it('warns when total does not match subtotal+tax', () => {
    const canonical = {
      vehicle: { chassis: 'KSP210-001' },
      parties: { buyer: 'B' },
      pricing: { total: 1000000, subtotal: 800000, tax: 100000 }, // should be 900000
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e: ValidationError) => e.rule === 'cross_check')).toBe(true);
  });

  it('passes cross-check within 1% tolerance', () => {
    const canonical = {
      vehicle: { chassis: 'KSP210-001' },
      parties: { buyer: 'B' },
      pricing: { total: 1000000, subtotal: 900000, tax: 100000 }, // exact match
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e: ValidationError) => e.rule === 'cross_check')).toBe(false);
  });

  it('errors on missing price fields', () => {
    const canonical = {
      vehicle: { chassis: 'KSP210-001' },
      parties: {},
      pricing: {},
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e: ValidationError) => e.field === 'pricing' && e.severity === 'error')).toBe(true);
  });

  it('warns on bad date', () => {
    const canonical = {
      vehicle: { chassis: 'KSP210-001' },
      parties: { buyer: 'B' },
      pricing: { total: 100000 },
      dates: { purchaseDate: 'not-a-date' },
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e: ValidationError) => e.field === 'dates.purchaseDate' && e.rule === 'format')).toBe(true);
  });
});

describe('BillingValidator', () => {
  let validator: BillingValidator;

  beforeEach(() => {
    validator = new BillingValidator();
  });

  it('passes a valid billing document', () => {
    const canonical = {
      invoiceNumber: 'INV-2024-001',
      vendor: '株式会社テスト',
      client: 'NAZLI TRADING',
      invoiceDate: '2024-03-15',
      lineItems: [{ originalDescription: 'Car', englishDescription: 'Car', confidence: 0.9 }],
      totals: { subtotal: 1000000, tax: 100000, total: 1100000 },
    };
    const errors = validator.validate(canonical);
    const hardErrors = errors.filter((e) => e.severity === 'error');
    expect(hardErrors).toHaveLength(0);
  });

  it('errors when invoice number is missing', () => {
    const canonical = {
      lineItems: [{}],
      totals: { total: 100000 },
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e) => e.field === 'invoiceNumber' && e.severity === 'error')).toBe(true);
  });

  it('errors when total is missing', () => {
    const canonical = {
      invoiceNumber: 'INV-001',
      lineItems: [{}],
      totals: {},
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e) => e.field === 'totals.total' && e.severity === 'error')).toBe(true);
  });

  it('warns when subtotal + tax != total', () => {
    const canonical = {
      invoiceNumber: 'INV-001',
      lineItems: [{}],
      totals: { subtotal: 1000, tax: 100, total: 2000 }, // wrong
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e) => e.rule === 'sum_check')).toBe(true);
  });

  it('validates line item arithmetic', () => {
    const canonical = {
      invoiceNumber: 'INV-001',
      totals: { total: 100000 },
      lineItems: [
        { quantity: 2, unitPrice: 1000, amount: 5000 }, // should be 2000
      ],
    };
    const errors = validator.validate(canonical);
    expect(errors.some((e) => e.rule === 'line_sum')).toBe(true);
  });
});
