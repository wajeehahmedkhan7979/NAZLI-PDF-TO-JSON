import {
  Controller, Get, Post, Param, Body, Query, Req,
  UseGuards, ParseUUIDPipe, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiParam, ApiBody, ApiQuery } from '@nestjs/swagger';
import { Request } from 'express';
import { ReviewService } from './review.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';

@ApiTags('Review')
@Controller('api/v1/review')
@UseGuards(ApiKeyGuard)
@ApiHeader({ name: 'x-api-key', required: true })
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Get('queue')
  @ApiOperation({ summary: 'Get documents needing human review' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getQueue(
    @Req() req: Request,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    return this.reviewService.getReviewQueue(tenantId, page, limit);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a document with optional corrections' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        reviewer: { type: 'string', example: 'admin@example.com' },
        corrections: {
          type: 'object',
          description: 'Dot-notation field corrections, e.g. { "vendor.english": "Corrected Name" }',
          example: { 'vendor.english': 'Sample Corp.' },
        },
        notes: { type: 'string', example: 'Vendor name was wrong' },
      },
      required: ['reviewer'],
    },
  })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Body() body: { reviewer: string; corrections?: Record<string, any>; notes?: string },
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    return this.reviewService.approveDocument(id, tenantId, body.reviewer, body.corrections, body.notes);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a document with a reason' })
  @ApiParam({ name: 'id', type: String })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        reviewer: { type: 'string', example: 'admin@example.com' },
        reason: { type: 'string', example: 'Unreadable scan' },
      },
      required: ['reviewer', 'reason'],
    },
  })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Body() body: { reviewer: string; reason: string },
  ) {
    const tenantId = (req.headers['x-tenant-id'] as string) || 'default-tenant';
    return this.reviewService.rejectDocument(id, tenantId, body.reviewer, body.reason);
  }
}
