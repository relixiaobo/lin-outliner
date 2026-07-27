import { randomBytes } from 'node:crypto';

let lastTimestamp = -1;
let sequence = 0;

/** Generates a monotonically ordered RFC 9562 UUIDv7 within this process. */
export function uuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffff_ffff_ffff) {
    throw new Error('UUIDv7 timestamp must be a non-negative 48-bit integer');
  }

  if (now > lastTimestamp) {
    lastTimestamp = now;
    sequence = randomBytes(2).readUInt16BE(0) & 0x0fff;
  } else {
    now = lastTimestamp;
    sequence = (sequence + 1) & 0x0fff;
    if (sequence === 0) {
      lastTimestamp += 1;
      now = lastTimestamp;
    }
  }

  const bytes = randomBytes(16);
  bytes[0] = Math.floor(now / 0x1_0000_0000_00) & 0xff;
  bytes[1] = Math.floor(now / 0x1_0000_0000) & 0xff;
  bytes[2] = Math.floor(now / 0x1_0000_00) & 0xff;
  bytes[3] = Math.floor(now / 0x1_0000) & 0xff;
  bytes[4] = Math.floor(now / 0x100) & 0xff;
  bytes[5] = (now % 0x100) & 0xff;
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
