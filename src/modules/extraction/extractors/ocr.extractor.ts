import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWorker } from 'tesseract.js';
import { ExtractionResultBlock } from './pdf-text.extractor';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

@Injectable()
export class OcrExtractor {
  private readonly logger = new Logger(OcrExtractor.name);
  private readonly tesseractLang: string;
  private readonly minConfidence: number;

  constructor(private configService: ConfigService) {
    this.tesseractLang = this.configService.get<string>('ocr.tesseractLang') || 'jpn';
    this.minConfidence = this.configService.get<number>('ocr.minConfidence') || 0.6;
  }

  async extract(imageOrPdfPaths: string[]): Promise<ExtractionResultBlock[]> {
    const expandedPaths = await this.expandPdfPages(imageOrPdfPaths);
    this.logger.debug(`Running OCR on ${expandedPaths.length} rendered page images`);

    if (expandedPaths.length === 0) {
      throw new Error('OCR failed: no page images available for recognition');
    }

    const blocks: ExtractionResultBlock[] = [];
    const worker = await createWorker(this.tesseractLang);

    try {
      for (let i = 0; i < expandedPaths.length; i++) {
        const pageNum = i + 1;
        const result = await worker.recognize(expandedPaths[i]);

        result.data.paragraphs.forEach((paragraph) => {
          if (paragraph.confidence / 100 >= this.minConfidence) {
            blocks.push({
              type: 'text',
              text: paragraph.text.trim(),
              confidence: paragraph.confidence / 100,
              page: pageNum,
              bbox: {
                x: paragraph.bbox.x0,
                y: paragraph.bbox.y0,
                width: paragraph.bbox.x1 - paragraph.bbox.x0,
                height: paragraph.bbox.y1 - paragraph.bbox.y0,
              },
            });
          }
        });
      }
    } finally {
      await worker.terminate();
      for (const p of expandedPaths) {
        if (p.includes('/nazli-ocr-') && p.endsWith('.png')) {
          await fs.promises.unlink(p).catch(() => undefined);
        }
      }
    }

    return blocks;
  }

  private async expandPdfPages(paths: string[]): Promise<string[]> {
    const outputs: string[] = [];

    for (const inputPath of paths) {
      if (inputPath.toLowerCase().endsWith('.pdf')) {
        const rendered = await this.renderPdfToImages(inputPath);
        outputs.push(...rendered);
      } else {
        outputs.push(inputPath);
      }
    }

    return outputs;
  }

  private async renderPdfToImages(pdfPath: string): Promise<string[]> {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nazli-ocr-'));
    const outPrefix = path.join(tempDir, 'page');

    await execFileAsync('pdftoppm', ['-png', '-r', '180', pdfPath, outPrefix]);

    const files = (await fs.promises.readdir(tempDir))
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => {
        const ai = parseInt(a.match(/(\d+)/)?.[1] || '0', 10);
        const bi = parseInt(b.match(/(\d+)/)?.[1] || '0', 10);
        return ai - bi;
      })
      .map((name) => path.join(tempDir, name));

    if (files.length === 0) {
      throw new Error(`OCR render failed: no pages rendered from ${pdfPath}`);
    }

    return files;
  }
}
