/** Size the serialized model data, including UTF-8 and JSON escaping. */
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Retain a complete Unicode prefix that fits a JSON string's byte allowance. */
export function boundJsonString(value: string, maxBytes: number): string {
  if (jsonByteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonByteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Never expose half of an astral character at the truncation boundary.
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low -= 1;
  return value.slice(0, low);
}
