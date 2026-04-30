import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient, DocumentStatus } from '@prisma/client';

const prisma = new PrismaClient();

@Injectable()
export class QualityGateService {
  private readonly logger = new Logger(QualityGateService.name);

  // Determine final status based on confidence and flags
  async evaluate(documentId: string): Promise<DocumentStatus> {
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new Error(`Document ${documentId} not found`);

    const confidence = document.overallConfidence || 0;
    const flags = document.qualityFlags || [];
    
    let nextStatus: DocumentStatus = 'COMPLETED';

    if (confidence < 0.3) {
      nextStatus = 'REJECTED';
      this.logger.warn(`Document ${documentId} rejected due to extreme low confidence (${confidence.toFixed(2)})`);
    } 
    else if (confidence < 0.85 || flags.length > 0) {
      nextStatus = 'NEEDS_REVIEW';
      this.logger.log(`Document ${documentId} flagged for review. Confidence (${confidence.toFixed(2)}) < 0.85 or Flags present: ${flags.join(',')}`);
    } 
    else {
      nextStatus = 'COMPLETED'; // Auto Accept
      this.logger.log(`Document ${documentId} auto-accepted. Confidence: ${confidence}`);
    }

    await prisma.document.update({
      where: { id: documentId },
      data: { 
        status: nextStatus,
        stage: 'QUALITY_CHECKED' 
      }
    });

    return nextStatus;
  }
}
