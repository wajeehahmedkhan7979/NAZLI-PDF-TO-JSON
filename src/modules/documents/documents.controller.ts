import {
  Controller, Get, Post, Param, Query, Req, Res,
  UseGuards, ParseUUIDPipe, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
  ApiTags, ApiOperation, ApiHeader, ApiParam,
  ApiQuery, ApiResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import * as fs from 'fs';
import { DocumentsService } from './documents.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';

@ApiTags('Purchase')
@Controller('api/purchase')
@UseGuards(ApiKeyGuard)
@ApiHeader({ name: 'x-api-key', required: true })
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  // ──────────────────────── STATUS ────────────────────────
  @Get(':id/status')
  @ApiOperation({ summary: 'Get purchase processing status' })
  @ApiParam({ name: 'id', type: String })
  async getStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    const doc = await this.documentsService.getRawDocument(id, tenantId);
    return {
      documentId: doc.id,
      status: doc.status,
      stage: doc.stage,
      progress: 100, // Metadata mapping skipped for simplicity here
      updatedAt: doc.updatedAt
    };
  }

  // ──────────────────────── RESULT ────────────────────────
  @Get(':id/result')
  @ApiOperation({ summary: 'Get purchase extraction result (ERP-ready)' })
  @ApiParam({ name: 'id', type: String })
  async getResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    const doc = await this.documentsService.getRawDocument(id, tenantId);
    const erpPayload = await this.documentsService.getErpPayload(id, tenantId);
    const validationErrors = doc.validationErrors as any[];
    
    // Structure return to be STRICT for ERP
    return {
      success: doc.status === 'COMPLETED' || doc.status === 'NEEDS_REVIEW',
      confidence: doc.overallConfidence || 0,
      records: erpPayload || [], // This will be ErpPayload[]
      warnings: validationErrors?.filter(e => e.severity === 'warning') || [],
      errors: validationErrors?.filter(e => e.severity === 'error') || []
    };
  }
}
