// Small runtime-neutral helpers: base64url, canonical JSON, hashing and constant-time comparison.
// Only globals that Node 20+, Deno, Bun and Cloudflare Workers all provide (TextEncoder, btoa, atob,
// crypto.subtle) are used, so the core has no runtime dependencies.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url; returns undefined for anything that isn't strict base64url. */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/** Compares two byte arrays in time that depends only on their length (which is never secret here). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * JSON with object keys sorted at every level, so equal values always serialize to the same text.
 * Follows JSON.stringify for everything else (toJSON, undefined, non-finite numbers).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set()) ?? 'null';
}

function serialize(value: unknown, seen: Set<object>): string | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON(): unknown }).toJSON();
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') throw new TypeError('canonicalJson cannot serialize a BigInt');
    return JSON.stringify(value);
  }
  if (seen.has(value)) throw new TypeError('canonicalJson cannot serialize a circular structure');
  seen.add(value);
  let out: string;
  if (Array.isArray(value)) {
    out = `[${value.map((item) => serialize(item, seen) ?? 'null').join(',')}]`;
  } else {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const text = serialize((value as Record<string, unknown>)[key], seen);
      if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`);
    }
    out = `{${parts.join(',')}}`;
  }
  seen.delete(value);
  return out;
}

/** SHA-256 of the canonical JSON of `value`, base64url-encoded. */
export async function hashJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(canonicalJson(value)));
  return base64UrlEncode(new Uint8Array(digest));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
