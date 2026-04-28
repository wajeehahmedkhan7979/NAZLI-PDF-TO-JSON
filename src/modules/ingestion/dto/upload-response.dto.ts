import { ApiProperty } from '@nestjs/swagger';

export class UploadResponseDto {
  @ApiProperty({ description: 'The unique ID assigned to the document' })
  documentId: string;

  @ApiProperty({ description: 'The background job ID' })
  jobId: string;

  @ApiProperty({ description: 'Current status of the document', example: 'QUEUED' })
  status: string;
}
