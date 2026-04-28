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

@ApiTags('Documents')
@Controller('api/v1/documents')
@UseGuards(ApiKeyGuard)
@ApiHeader({ name: 'x-api-key', required: true })
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  // ───────────────────────── LIST ─────────────────────────
  @Get()
  @ApiOperation({ summary: 'List all documents with pagination and filters' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'type', required: false, type: String })
  async listDocuments(
    @Req() req: Request,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('type') type?: string,
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    return this.documentsService.listDocuments({ tenantId, page, limit, status, type });
  }

  // ───────────────────────── DETAIL ───────────────────────
  @Get(':id')
  @ApiOperation({ summary: 'Get document detail (frontend presentation)' })
  @ApiParam({ name: 'id', type: String })
  async getDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    return this.documentsService.getDocument(id, tenantId);
  }

  // ───────────────────── CANONICAL (admin) ────────────────
  @Get(':id/canonical')
  @ApiOperation({ summary: 'Get canonical internal JSON' })
  async getCanonical(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    return this.documentsService.getCanonical(id, tenantId);
  }

  // ───────────────────── RAW DOWNLOAD ─────────────────────
  @Get(':id/raw')
  @ApiOperation({ summary: 'Download original PDF file' })
  async getRaw(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    const filePath = await this.documentsService.getRawFilePath(id, tenantId);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'Raw file not found on disk' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${id}.pdf"`);
    fs.createReadStream(filePath).pipe(res);
  }

  // ──────────────────── EXTRACTIONS ───────────────────────
  @Get(':id/extractions')
  @ApiOperation({ summary: 'Get raw extraction results' })
  async getExtractions(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    return this.documentsService.getExtractions(id, tenantId);
  }

  // ───────────────────── AUDIT TRAIL ──────────────────────
  @Get(':id/audit')
  @ApiOperation({ summary: 'Get audit trail for a document' })
  async getAudit(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    return this.documentsService.getAuditTrail(id, tenantId);
  }

  // ───────────────────── REPROCESS ────────────────────────
  @Post(':id/reprocess')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Re-queue document for processing' })
  async reprocess(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    // Delegate to orchestrator (will be wired in later)
    return { message: `Document ${id} queued for reprocessing`, documentId: id };
  }
}
