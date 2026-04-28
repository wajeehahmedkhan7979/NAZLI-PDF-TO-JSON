import { Module } from '@nestjs/common';
import { CharacterNormalizer } from './normalizers/character.normalizer';
import { DateNormalizer } from './normalizers/date.normalizer';
import { NumberNormalizer } from './normalizers/number.normalizer';
import { UnitNormalizer } from './normalizers/unit.normalizer';
import { VendorNormalizer } from './normalizers/vendor.normalizer';

@Module({
  providers: [
    CharacterNormalizer,
    DateNormalizer,
    NumberNormalizer,
    UnitNormalizer,
    VendorNormalizer
  ],
  exports: [
    CharacterNormalizer,
    DateNormalizer,
    NumberNormalizer,
    UnitNormalizer,
    VendorNormalizer
  ],
})
export class NormalizationModule {}
