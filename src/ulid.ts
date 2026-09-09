// Crockford-style ULID from crypto randomness. 26 chars, sortable.
import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
  const bytes = randomBytes(16);
  let time = Date.now();
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = ENCODING[time % 32] + out;
    time = Math.floor(time / 32);
  }
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ENCODING[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ENCODING[(acc << (5 - bits)) & 31];
  return out.slice(0, 26);
}
