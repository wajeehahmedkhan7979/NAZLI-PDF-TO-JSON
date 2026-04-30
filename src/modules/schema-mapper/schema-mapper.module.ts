import { Module } from '@nestjs/common';
import { SchemaMapperService } from './schema-mapper.service';
import { ErpAdapterService } from './erp-adapter.service';

@Module({
  providers: [
    SchemaMapperService,
    ErpAdapterService
  ],
  exports: [SchemaMapperService, ErpAdapterService],
})
export class SchemaMapperModule {}
