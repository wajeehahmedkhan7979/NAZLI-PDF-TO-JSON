import { z } from 'zod';

/**
 * Strict schema for a single purchase record (vehicle extraction).
 */
export const PurchaseRecordSchema = z.object({
  date: z.string(),                        // ISO 8601 date, e.g. "2026-04-04"
  auction: z.string(),                     // Platform name
  area: z.string(),                        // English area name
  lotNumber: z.number().int().optional(),
  year: z.number().int(),                  // Calendar year of event
  chassis: z.string(),                     // e.g. "KSP210-0116561"
  bid: z.number().nonnegative(),           // Starting bid
  recycle: z.number().nonnegative().optional(),
  jidosha: z.number().nonnegative().optional(),
  auctionFee: z.number().nonnegative().optional(),
  total: z.number().nonnegative(),         // Final price / winning bid

  // Traceability
  confidence: z.number().min(0).max(1),
  flags: z.array(z.string()).default([]),
});

export type PurchaseRecord = z.infer<typeof PurchaseRecordSchema>;

/**
 * Full extraction result contract.
 */
export const PurchaseExtractionResultSchema = z.object({
  status: z.enum(['SUCCESS', 'PARTIAL', 'FAILED']),
  records: z.array(PurchaseRecordSchema),
  confidence: z.number().min(0).max(1),
  errors: z.array(z.string()).default([]),
});

export type PurchaseExtractionResult = z.infer<typeof PurchaseExtractionResultSchema>;
