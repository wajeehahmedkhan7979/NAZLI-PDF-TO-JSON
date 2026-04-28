import { Module } from '@nestjs/common';
import {
  SchemaMapperService,
  PurchaseMapper,
  BillingMapper,
  AuctionMapper,
} from './schema-mapper.service';

@Module({
  providers: [
    SchemaMapperService,
    PurchaseMapper,
    BillingMapper,
    AuctionMapper,
  ],
  exports: [SchemaMapperService],
})
export class SchemaMapperModule {}
