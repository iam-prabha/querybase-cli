import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      }
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, KEYLEN);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
