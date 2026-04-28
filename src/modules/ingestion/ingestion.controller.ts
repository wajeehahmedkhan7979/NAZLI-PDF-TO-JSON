import { Controller, Post, UseInterceptors, UploadedFile, UseGuards, Req, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiHeader, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { IngestionService } from './ingestion.service';
import { UploadResponseDto } from './dto/upload-response.dto';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';

@ApiTags('Ingestion')
@Controller('api/v1/documents')
@UseGuards(ApiKeyGuard)
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post('upload')
  @ApiOperation({ summary: 'Upload a Japanese PDF for processing' })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: 'x-api-key', required: true, description: 'API Auth Key' })
  @ApiHeader({ name: 'x-tenant-id', required: false, description: 'Optional Tenant ID for isolation' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'The PDF file to upload',
        },
      },
    },
  })
  @ApiResponse({ status: 201, type: UploadResponseDto, description: 'File accepted and queued for processing' })
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File, @Req() request: Request): Promise<UploadResponseDto> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const tenantId = (request.headers['x-tenant-id'] as string) || 'default-tenant';

    return this.ingestionService.processUpload(file, tenantId);
  }
}
