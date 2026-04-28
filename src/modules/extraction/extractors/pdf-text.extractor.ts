import { Injectable, Logger } from '@nestjs/common';
import * as pdfParse from 'pdf-parse';
import * as fs from 'fs';

export interface ExtractionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractionResultBlock {
  type: 'text' | 'table_row';
  text: string;
  confidence: number;
  bbox?: ExtractionBox;
  page: number;
}

@Injectable()
export class PdfTextExtractor {
  private readonly logger = new Logger(PdfTextExtractor.name);

  async extract(filePath: string): Promise<ExtractionResultBlock[]> {
    this.logger.debug(`Extracting digital text from ${filePath}`);
    const dataBuffer = await fs.promises.readFile(filePath);
    
    // We use line-by-line parsing as a rough bounding box proxy for digital PDFs
    const pdfData = await pdfParse(dataBuffer);
    const pages = pdfData.text.split('\n\n\n'); // Approximate page split from pdf-parse
    
    const blocks: ExtractionResultBlock[] = [];
    
    pages.forEach((pageText, idx) => {
      const pageNum = idx + 1;
      const lines = pageText.split('\n').filter(l => l.trim().length > 0);
      
      lines.forEach((line) => {
        blocks.push({
          type: 'text',
          text: line.trim(),
          confidence: 1.0, // Digital text is exact
          page: pageNum,
          // bbox: omitted config since pdf-parse doesn't provide exact coordinates natively
        });
      });
    });

    return blocks;
  }
}
