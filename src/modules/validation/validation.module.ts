import { Module } from '@nestjs/common';
import { ValidationService } from './validation.service';
import { QualityGateService } from './quality-gate.service';

@Module({
  providers: [ValidationService, QualityGateService],
  exports: [ValidationService, QualityGateService],
})
export class ValidationModule {}
