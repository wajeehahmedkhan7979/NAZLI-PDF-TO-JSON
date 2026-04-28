import { z } from 'zod';

/**
 * Schema for a single auction row — one vehicle record.
 */
export const AuctionRowSchema = z.object({
  date: z.string(),                        // ISO 8601 date, e.g. "2026-04-04"
  auctionPlatform: z.string(),             // e.g. "TC-web", "ANS", "USS"
  auctionLocation: z.string(),             // English area name, e.g. "Hyogo"
  lotNumber: z.number().int().optional(),  // Exhibit/lot number
  year: z.number().int(),                  // Calendar year of event
  chassis: z.string(),                     // e.g. "KSP210-0116561"
  carName: z.string().optional(),          // Japanese or transliterated car name
  startingPrice: z.number().nonnegative().optional(), // Header bid value
  recycle: z.number().nonnegative().optional(),
  jidosha: z.number().nonnegative().optional(),
  auctionFee: z.number().nonnegative().optional(),
  finalPrice: z.number().nonnegative(),    // Actual winning bid

  // Per-row quality metadata
  confidence: z.number().min(0).max(1),
  flags: z.array(z.string()).optional(),
  rawBlock: z.array(z.string()).optional(), // Preserved raw lines for review
});

export type AuctionRow = z.infer<typeof AuctionRowSchema>;

/**
 * Schema for the full auction sheet document output.
 */
export const AuctionSheetDocumentSchema = z.object({
  type: z.literal('AUCTION_SHEET'),
  rows: z.array(AuctionRowSchema),
  meta: z.object({
    sourceFile: z.string(),
    parsedAt: z.string(),      // ISO 8601 datetime
    totalRows: z.number().int(),
    validRows: z.number().int(),
    invalidRows: z.number().int(),
    documentDate: z.string().optional(),
    issuer: z.string().optional(),
    client: z.string().optional(),
  }),
});

export type AuctionSheetDocument = z.infer<typeof AuctionSheetDocumentSchema>;
