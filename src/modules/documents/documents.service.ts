import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FrontendDocument } from '../../common/schemas/frontend.schema';

const prisma = new PrismaClient();

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  /**
   * List documents with pagination and optional filters.
   */
  async listDocuments(options: {
    tenantId: string;
    page?: number;
    limit?: number;
    status?: string;
    type?: string;
  }) {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = { tenantId: options.tenantId };
    if (options.status) where.status = options.status;
    if (options.type) where.documentType = options.type;

    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          originalName: true,
          status: true,
          stage: true,
          documentType: true,
          overallConfidence: true,
          qualityFlags: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.document.count({ where }),
    ]);

    return {
      data: documents,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get single document in frontend presentation format.
   */
  async getDocument(documentId: string, tenantId: string): Promise<FrontendDocument> {
    const doc = await prisma.document.findFirst({
      where: { id: documentId, tenantId },
      include: { lineItems: { orderBy: { lineNumber: 'asc' } } },
    });

    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);

    const canonical: any = doc.canonicalJson || {};

    return {
      id: doc.id,
      vendorName: canonical.vendor?.english || canonical.vendor?.original || doc.originalName,
      documentDate: canonical.documentMeta?.documentDate || null,
      documentType: doc.documentType || 'UNKNOWN',
      status: doc.status,
      summary: {
        currency: canonical.documentMeta?.currency || 'JPY',
        subtotal: canonical.totals?.subtotal,
        tax: canonical.totals?.tax,
        total: canonical.totals?.total,
      },
      items: (doc.lineItems || []).map((item) => ({
        description: item.englishDescription || item.originalDescription,
        originalDescription: item.originalDescription,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unitPrice,
        lineTotal: item.subtotal,
      })),
      source: {
        originalLanguage: doc.sourceLanguage || 'ja',
        confidence: doc.overallConfidence || 0,
      },
      flags: doc.qualityFlags || [],
    };
  }

  /**
   * Get canonical (internal) JSON — for debugging / admin views.
   */
  async getCanonical(documentId: string, tenantId: string) {
    const doc = await prisma.document.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);
    return doc.canonicalJson;
  }

  /**
   * Get raw extraction data for a document.
   */
  async getExtractions(documentId: string, tenantId: string) {
    const doc = await prisma.document.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);

    const extractions = await prisma.extraction.findMany({
      where: { documentId },
      orderBy: { page: 'asc' },
    });
    return extractions;
  }

  /**
   * Get audit trail for a document.
   */
  async getAuditTrail(documentId: string, tenantId: string) {
    const doc = await prisma.document.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);

    const logs = await prisma.auditLog.findMany({
      where: { documentId },
      orderBy: { createdAt: 'asc' },
    });
    return logs;
  }

  /**
   * Get the raw PDF file path for download.
   */
  async getRawFilePath(documentId: string, tenantId: string): Promise<string> {
    const doc = await prisma.document.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);
    return doc.storagePath;
  }
}
