import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

@Injectable()
export class VirusScannerService {
  private readonly logger = new Logger(VirusScannerService.name);
  private clamscanAvailable = false;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    
    try {
      await execAsync('which clamscan');
      this.clamscanAvailable = true;
      this.logger.log('ClamAV detected. Virus scanning enabled.');
    } catch {
      this.logger.warn('ClamAV not installed on system. Virus scanning will be bypassed.');
      this.clamscanAvailable = false;
    }
    
    this.initialized = true;
  }

  async scanFile(filePath: string): Promise<boolean> {
    await this.init();

    if (!this.clamscanAvailable) {
      // Graceful degradation per architecture review
      return true;
    }

    if (!fs.existsSync(filePath)) {
      this.logger.error(`File not found for scanning: ${filePath}`);
      return false; // Fail safe
    }

    try {
      const { stdout } = await execAsync(`clamscan --no-summary "${filePath}"`);
      if (stdout.includes('OK')) {
        return true;
      }
      this.logger.warn(`Virus scan failed for ${filePath}: ${stdout}`);
      return false;
    } catch (error: any) {
      // clamscan returns exit code 1 if virus found
      this.logger.error(`Malware detected or scan error in ${filePath}: ${error.message}`);
      return false;
    }
  }
}
