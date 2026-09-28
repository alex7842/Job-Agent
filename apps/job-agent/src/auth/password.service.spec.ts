import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service.js';

const passwords = new PasswordService();

describe('PasswordService', () => {
  it('verifies a password it just hashed', async () => {
    const hash = await passwords.hash('correct-horse-battery');
    expect(await passwords.verify('correct-horse-battery', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await passwords.hash('correct-horse-battery');
    expect(await passwords.verify('correct-horse-batterY', hash)).toBe(false);
    expect(await passwords.verify('', hash)).toBe(false);
  });

  it('never stores the password itself', async () => {
    const hash = await passwords.hash('correct-horse-battery');
    expect(hash).not.toContain('correct-horse-battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('salts, so equal passwords get different digests', async () => {
    const [a, b] = await Promise.all([
      passwords.hash('same-password'),
      passwords.hash('same-password'),
    ]);
    expect(a).not.toBe(b);
    expect(await passwords.verify('same-password', a)).toBe(true);
    expect(await passwords.verify('same-password', b)).toBe(true);
  });

  it('treats a malformed or foreign hash as a failed login, not a crash', async () => {
    for (const bad of ['', 'not-a-hash', 'bcrypt$10$x$y', 'scrypt$nope$8$1$c2FsdA==$aGFzaA==']) {
      expect(await passwords.verify('anything', bad)).toBe(false);
    }
  });

  it('normalises unicode so equivalent input still matches', async () => {
    // "é" composed vs decomposed: same password, one codepoint sequence apart.
    const composed = 'café-password';
    const decomposed = 'café-password';
    const hash = await passwords.hash(composed);
    expect(await passwords.verify(decomposed, hash)).toBe(true);
  });
});
