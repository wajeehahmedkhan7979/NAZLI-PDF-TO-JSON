import { Injectable, Logger } from '@nestjs/common';
import { CanonicalDocument, CanonicalDocumentSchema } from '../../common/schemas/canonical.schema';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  async validateAndMap(documentId: string, translatedData: any): Promise<void> {
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new Error(`Document ${documentId} not found`);

    let flags: string[] = [];
    
    // 1. Zod Schema Validation
    const validationResult = CanonicalDocumentSchema.safeParse(translatedData);
    let canonicalJson = translatedData;
    let errors = null;

    if (!validationResult.success) {
      flags.push('SCHEMA_MISMATCH');
      errors = validationResult.error.format();
      this.logger.warn(`Schema validation failed for ${documentId}`, errors);
    } else {
      canonicalJson = validationResult.data;
    }

    // 2. Business Logic Validation (Reconciliation)
    const totals = canonicalJson.totals || {};
    const lineItems = canonicalJson.lineItems || [];
    
    if (totals.subtotal !== undefined) {
      const lineItemSum = lineItems.reduce((acc: number, item: any) => acc + (item.subtotal || 0), 0);
      // Allow minor floating point / rounding tolerance
      if (Math.abs(lineItemSum - totals.subtotal) > 1.0) {
        flags.push('TOTALS_MISMATCH');
        this.logger.warn(`Totals mismatch for ${documentId}: sum=${lineItemSum}, expected=${totals.subtotal}`);
      }
    }

    if (totals.subtotal !== undefined && totals.tax !== undefined && totals.total !== undefined) {
      if (Math.abs(totals.subtotal + totals.tax - totals.total) > 1.0) {
        flags.push('MATH_ERROR');
      }
    }

    // Embed flags into quality block
    canonicalJson.quality = {
      ...canonicalJson.quality,
      flags: [...(canonicalJson.quality?.flags || []), ...flags]
    };

    // 3. Update Document
    await prisma.document.update({
      where: { id: documentId },
      data: {
        canonicalJson,
        validationErrors: errors,
        qualityFlags: flags,
        stage: 'VALIDATED'
      }
    });

    this.logger.log(`Validation complete for ${documentId}. Flags: ${flags.length}`);
  }
}
