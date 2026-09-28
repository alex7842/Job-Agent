import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt parameters. N=16384/r=8/p=1 is the interactive-login recommendation
 * (OWASP), costing roughly 50-100ms and 32MiB per hash on a laptop.
 *
 * bcrypt/argon2 would need a native build, which is friction in pnpm and in the
 * deploy target; `node:crypto` is already here and needs no dependency.
 */
const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
// scrypt needs roughly 128 * N * r bytes; give it headroom above the default 32MiB.
const MAXMEM = 128 * N * R * 2;

/** Stored as `scrypt$N$r$p$salt$hash`, so parameters can change without invalidating old rows. */
const SCHEME = 'scrypt';

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derived = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, {
      N,
      r: R,
      p: P,
      maxmem: MAXMEM,
    });
    return [SCHEME, N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
  }

  /** Constant-time comparison; a malformed or foreign hash is simply `false`. */
  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== SCHEME) return false;

    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

    const expected = Buffer.from(hashB64, 'base64');
    let derived: Buffer;
    try {
      derived = await scryptAsync(
        password.normalize('NFKC'),
        Buffer.from(saltB64, 'base64'),
        expected.length,
        {
          N: n,
          r,
          p,
          maxmem: MAXMEM,
        },
      );
    } catch {
      return false;
    }

    // timingSafeEqual throws on length mismatch, so check length first.
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
}
