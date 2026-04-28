import { Injectable, UnsupportedMediaTypeException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FileValidatorService {
  private readonly maxSizeBytes: number;

  constructor(private configService: ConfigService) {
    this.maxSizeBytes = this.configService.get<number>('storage.maxSize') || 20 * 1024 * 1024;
  }

  async validatePdf(buffer: Buffer, originalName: string, mimeType: string): Promise<void> {
    // Basic MIME check
    if (mimeType !== 'application/pdf' && !originalName.toLowerCase().endsWith('.pdf')) {
      throw new UnsupportedMediaTypeException('Only PDF files are allowed');
    }

    // Size check
    if (buffer.length > this.maxSizeBytes) {
      throw new PayloadTooLargeException(`File exceeds maximum size of ${this.maxSizeBytes / 1024 / 1024}MB`);
    }

    // Advanced magic bytes check
    try {
      const fileType = await import('file-type');
      const type = await fileType.fileTypeFromBuffer(buffer);
      
      if (!type || type.mime !== 'application/pdf') {
        throw new UnsupportedMediaTypeException('File content does not match PDF signature');
      }
    } catch (error) {
      // If file-type fails to load (can happen with ESM/CJS mix during scaffold), fallback to basic magic byte check
      const pdfHeader = Buffer.from('%PDF');
      if (buffer.length < 4 || !buffer.subarray(0, 4).equals(pdfHeader)) {
         throw new UnsupportedMediaTypeException('File content does not have a valid PDF header');
      }
    }
  }
}
