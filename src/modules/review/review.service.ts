import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  /**
   * Get all documents that need human review.
   */
  async getReviewQueue(tenantId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [docs, total] = await Promise.all([
      prisma.document.findMany({
        where: { tenantId, status: 'NEEDS_REVIEW' },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          originalName: true,
          documentType: true,
          overallConfidence: true,
          qualityFlags: true,
          createdAt: true,
        },
      }),
      prisma.document.count({ where: { tenantId, status: 'NEEDS_REVIEW' } }),
    ]);

    return {
      data: docs,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Approve a document, optionally applying field-level corrections.
   */
  async approveDocument(
    documentId: string,
    tenantId: string,
    reviewer: string,
    corrections?: Record<string, any>,
    notes?: string,
  ) {
    const doc = await prisma.document.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);
    if (doc.status !== 'NEEDS_REVIEW' && doc.status !== 'QUEUED') {
      throw new BadRequestException(`Document is in status ${doc.status}, cannot approve`);
    }

    // Apply corrections to canonical JSON if provided
    let canonicalJson: any = doc.canonicalJson || {};
    if (corrections) {
      canonicalJson = this.applyCorrections(canonicalJson, corrections);
    }

    // Update document
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: 'APPROVED',
        stage: 'EXPOSED',
        canonicalJson,
      },
    });

    // Record the review action
    await prisma.reviewAction.create({
      data: {
        documentId,
        reviewer,
        action: 'approve',
        corrections: corrections || undefined,
        notes,
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        documentId,
        action: 'approved',
        stage: 'EXPOSED',
        actor: reviewer,
        details: { corrections, notes },
      },
    });

    // Learn from corrections: update glossary
    if (corrections) {
      await this.learnFromCorrections(corrections, tenantId);
    }

    this.logger.log(`Document ${documentId} approved by ${reviewer}`);
    return { documentId, status: 'APPROVED' };
  }

  /**
   * Reject a document with a reason.
   */
  async rejectDocument(
    documentId: string,
    tenantId: string,
    reviewer: string,
    reason: string,
  ) {
    const doc = await prisma.document.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);

    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'REJECTED' },
    });

    await prisma.reviewAction.create({
      data: {
        documentId,
        reviewer,
        action: 'reject',
        notes: reason,
      },
    });

    await prisma.auditLog.create({
      data: {
        documentId,
        action: 'rejected',
        actor: reviewer,
        details: { reason },
      },
    });

    this.logger.log(`Document ${documentId} rejected by ${reviewer}: ${reason}`);
    return { documentId, status: 'REJECTED' };
  }

  /**
   * Apply field-level corrections to canonical JSON.
   */
  private applyCorrections(canonical: any, corrections: Record<string, any>): any {
    const result = { ...canonical };

    // Support dot-notation paths like "vendor.english" or "lineItems.0.englishDescription"
    for (const [path, value] of Object.entries(corrections)) {
      const keys = path.split('.');
      let current = result;
      for (let i = 0; i < keys.length - 1; i++) {
        const key = isNaN(Number(keys[i])) ? keys[i] : Number(keys[i]);
        if (current[key] === undefined) current[key] = {};
        current = current[key];
      }
      const lastKey = keys[keys.length - 1];
      current[lastKey] = value;
    }

    return result;
  }

  /**
   * Learn from human corrections by adding new glossary entries.
   * This creates a feedback loop that improves future translations.
   */
  private async learnFromCorrections(corrections: Record<string, any>, tenantId: string) {
    // Example: if "vendor.english" was corrected, store the mapping
    if (corrections['vendor.english'] && corrections['vendor.original']) {
      try {
        await prisma.glossaryEntry.upsert({
          where: {
            tenantId_category_japanese: {
              tenantId,
              category: 'vendor',
              japanese: corrections['vendor.original'],
            },
          },
          update: { english: corrections['vendor.english'] },
          create: {
            tenantId,
            category: 'vendor',
            japanese: corrections['vendor.original'],
            english: corrections['vendor.english'],
            priority: 10, // Human-corrected entries get high priority
          },
        });
      } catch {
        // Non-critical: log but don't fail the approval
      }
    }
  }
}
