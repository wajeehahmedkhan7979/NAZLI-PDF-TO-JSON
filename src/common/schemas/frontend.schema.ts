import { z } from 'zod';

export const FrontendDocumentSchema = z.object({
  id: z.string().uuid(),
  vendorName: z.string(),
  documentDate: z.string().optional(),
  documentType: z.string(),
  status: z.string(),
  summary: z.object({
    currency: z.string().optional(),
    subtotal: z.number().optional(),
    tax: z.number().optional(),
    total: z.number().optional(),
  }),
  items: z.array(z.object({
    description: z.string(),
    originalDescription: z.string().optional(),
    quantity: z.number().optional(),
    unit: z.string().optional(),
    unitPrice: z.number().optional(),
    lineTotal: z.number().optional(),
  })),
  source: z.object({
    originalLanguage: z.string(),
    confidence: z.number(),
  }),
  flags: z.array(z.string()).optional(),
});

export type FrontendDocument = z.infer<typeof FrontendDocumentSchema>;
