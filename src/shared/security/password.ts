import argon2 from 'argon2';
import { fail } from '../errors/api-error.js';

export const MIN_PASSWORD_LENGTH = 15;
let activeOperations = 0;
async function bounded<T>(run: () => Promise<T>): Promise<T> {
  if (activeOperations >= 4)
    fail(503, 'AUTH_BUSY', 'Pemrosesan kredensial sedang penuh. Coba lagi.');
  activeOperations++;
  try {
    return await run();
  } finally {
    activeOperations--;
  }
}
export function hashPassword(password: string): Promise<string> {
  return bounded(() =>
    argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    }),
  );
}
export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  return bounded(async () => {
    try {
      return await argon2.verify(encoded, password);
    } catch {
      return false;
    }
  });
}
