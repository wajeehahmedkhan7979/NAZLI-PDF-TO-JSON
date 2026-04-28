import { z } from 'zod';
import { AuctionSheetDocumentSchema } from './auction.schema';

// ─── Invoice Document Schema (preserved) ─────────────────────
export const InvoiceDocumentSchema = z.object({
  type: z.literal('INVOICE').default('INVOICE'),
  documentId: z.string().uuid(),
  sourceLanguage: z.literal('ja'),
  sourceType: z.enum(['INVOICE', 'PURCHASE_ORDER', 'RECEIPT', 'PACKING_LIST', 'UNKNOWN']),
  vendor: z.object({
    original: z.string(),
    english: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  documentMeta: z.object({
    documentNumber: z.string().optional(),
    documentDate: z.string().optional(), // ISO 8601
    currency: z.string().length(3).optional(),
    pageCount: z.number().int().positive(),
  }),
  lineItems: z.array(z.object({
    originalDescription: z.string(),
    englishDescription: z.string().optional(),
    quantity: z.number().positive().optional(),
    unit: z.string().optional(),
    unitPrice: z.number().nonnegative().optional(),
    subtotal: z.number().nonnegative().optional(),
    confidence: z.number().min(0).max(1).optional(),
    provenance: z.object({
      page: z.number().int(),
      bbox: z.any().optional(),
      rawText: z.string(),
      extractionMethod: z.string(),
    }).optional(),
  })),
  totals: z.object({
    subtotal: z.number().nonnegative().optional(),
    tax: z.number().nonnegative().optional(),
    total: z.number().nonnegative().optional(),
  }),
  quality: z.object({
    overallConfidence: z.number().min(0).max(1),
    flags: z.array(z.string()),
  }),
});

export type InvoiceDocument = z.infer<typeof InvoiceDocumentSchema>;

// ─── Discriminated Union (extensible for future doc types) ────
export const CanonicalDocumentSchema = z.discriminatedUnion('type', [
  InvoiceDocumentSchema,
  AuctionSheetDocumentSchema,
]);

export type CanonicalDocument = z.infer<typeof CanonicalDocumentSchema>;
