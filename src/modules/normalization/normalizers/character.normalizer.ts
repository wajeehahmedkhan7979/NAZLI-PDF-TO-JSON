import { Injectable } from '@nestjs/common';

@Injectable()
export class CharacterNormalizer {
  // Convert full-width alphanumeric to half-width
  normalize(text: string): string {
    if (!text) return '';

    // 1. Full-width to half-width logic (Shift by 0xFEE0)
    let halfWidth = text.replace(/[\uFF01-\uFF5E]/g, (ch) => {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });

    // 2. Normalize spaces (full-width space to half-width)
    halfWidth = halfWidth.replace(/\u3000/g, ' ');

    // 3. Normalize punctuation
    halfWidth = halfWidth.replace(/。/g, '.').replace(/、/g, ',');

    // 4. Collapse whitespace
    halfWidth = halfWidth.replace(/\s+/g, ' ').trim();

    return halfWidth;
  }
}
