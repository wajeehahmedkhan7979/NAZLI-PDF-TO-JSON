import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

@Injectable()
export class VendorNormalizer {
  
  // Clean vendor string and map using glossary
  async normalize(rawVendor: string, tenantId: string): Promise<{name: string, english: string, confidence: number}> {
    if (!rawVendor) return { name: '', english: '', confidence: 0 };

    // Strip common legal suffixes/prefixes to find base name
    const suffixes = ['株式会社', '有限会社', '合名会社', '合資会社', '合同会社', '（株）', '(株)'];
    let baseName = rawVendor;
    for (const suffix of suffixes) {
      baseName = baseName.replace(suffix, '').trim();
    }

    // Lookup in Glossary
    const entry = await prisma.glossaryEntry.findFirst({
      where: {
        category: 'vendor',
        tenantId: { in: [tenantId, null] },
        japanese: { contains: baseName } // Basic fuzzy match
      },
      orderBy: { priority: 'desc' }
    });

    if (entry) {
      return {
        name: entry.japanese,     // Use canonical Japanese name
        english: entry.english,   // Translation
        confidence: entry.japanese === rawVendor ? 1.0 : 0.85 
      };
    }

    // Default passthrough if no entry
    return { name: rawVendor, english: rawVendor, confidence: 0.3 };
  }
}
