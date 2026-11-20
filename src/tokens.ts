import { base64UrlDecode, base64UrlEncode, fromUtf8, hashJson, timingSafeEqual, utf8 } from './encoding.ts';
import { GuardrailError } from './errors.ts';

/** An HMAC secret: a string (UTF-8) or raw bytes, at least 32 bytes long. */
export type Secret = string | Uint8Array;

/** Options for `createPreviewTokens`. */
export interface PreviewTokenOptions {
  /** Signs new tokens. Pass an array to rotate: the first signs, every one verifies. */
  secret: Secret | readonly Secret[];
  /** How long a token stays valid, in milliseconds. Default 15 minutes. */
  ttlMs?: number;
  /** Clock in milliseconds, for tests. Default `Date.now`. */
  now?: () => number;
}

/** What a preview token is bound to. Verification fails unless every part matches. */
export interface PreviewBinding {
  /** The operation, usually the tool name. */
  action: string;
  /** The resource it acts on, for example a record id. */
  resource: string;
  /** Who previewed it. Include the tenant when you have one, for example `${tenantId}:${userId}`. */
  actor: string;
  /** The arguments of the call; only their SHA-256 hash goes into the token. */
  payload?: unknown;
  /**
   * The state the plan was computed from (a count, a version). Only its hash goes into the token; when
   * it differs at confirm time the token is refused as `preview_stale`.
   */
  state?: unknown;
}

/** A freshly signed preview token. */
export interface IssuedPreview {
  token: string;
  /** ISO timestamp after which the token is refused. */
  expiresAt: string;
}

/** The verified claims of a preview token. */
export interface PreviewClaims {
  /** Random id of this token, for callers that want single use (store it until `expiresAt`). */
  id: string;
  action: string;
  resource: string;
  actor: string;
  issuedAt: number;
  expiresAt: number;
}

/** Signs and verifies preview tokens. */
export interface PreviewTokens {
  /** Validity of new tokens, in milliseconds. */
  readonly ttlMs: number;
  /** Signs a token bound to `binding`. */
  issue(binding: PreviewBinding): Promise<IssuedPreview>;
  /**
   * Verifies `token` against `binding`. Throws `preview_invalid` (malformed, tampered or signed with
   * another secret), `preview_expired`, `preview_mismatch` (lists what differs) or `preview_stale`.
   */
  verify(token: string, binding: PreviewBinding): Promise<PreviewClaims>;
}

interface TokenBody {
  v: 1;
  jti: string;
  act: string;
  res: string;
  sub: string;
  ph: string;
  sh?: string;
  iat: number;
  exp: number;
}

/** Default token lifetime: 15 minutes. */
export const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const MIN_SECRET_BYTES = 32;
const DOMAIN = 'mcp-guardrails/preview/v1.';

// WebCrypto key type without depending on the DOM lib.
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/**
 * Creates the signer for preview tokens: HMAC-SHA-256 over WebCrypto, so it runs on Node 20+ and edge
 * runtimes. Tokens are bound to an action, a resource, an actor and a hash of the payload, and expire.
 */
export function createPreviewTokens(options: PreviewTokenOptions): PreviewTokens {
  const secrets: readonly Secret[] = Array.isArray(options.secret) ? options.secret : [options.secret as Secret];
  if (secrets.length === 0) throw new TypeError('createPreviewTokens: pass at least one secret');
  const raw = secrets.map((secret) => (typeof secret === 'string' ? utf8(secret) : new Uint8Array(secret)));
  if (raw.some((bytes) => bytes.length < MIN_SECRET_BYTES)) {
    throw new TypeError(`createPreviewTokens: each secret needs at least ${MIN_SECRET_BYTES} bytes`);
  }
  const ttlMs = options.ttlMs ?? DEFAULT_PREVIEW_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0)
    throw new TypeError('createPreviewTokens: ttlMs must be a positive number');
  const now = options.now ?? Date.now;

  let keys: Promise<HmacKey[]> | undefined;
  const getKeys = () =>
    (keys ??= Promise.all(
      raw.map((bytes) => crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])),
    ));
  const sign = async (key: HmacKey, encoded: string) =>
    new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(DOMAIN + encoded)));

  const invalid = (reason: string) =>
    new GuardrailError(
      'preview_invalid',
      `The previewToken is not valid (${reason}). Call the preview again and use the new token unchanged.`,
    );

  return {
    ttlMs,

    async issue(binding) {
      const issuedAt = now();
      const body: TokenBody = {
        v: 1,
        jti: crypto.randomUUID(),
        act: binding.action,
        res: binding.resource,
        sub: binding.actor,
        ph: await hashJson(binding.payload ?? null),
        ...(binding.state === undefined ? {} : { sh: await hashJson(binding.state) }),
        iat: issuedAt,
        exp: issuedAt + ttlMs,
      };
      const encoded = base64UrlEncode(utf8(JSON.stringify(body)));
      const [signingKey] = await getKeys();
      const signature = base64UrlEncode(await sign(signingKey!, encoded));
      return { token: `${encoded}.${signature}`, expiresAt: new Date(body.exp).toISOString() };
    },

    async verify(token, binding) {
      if (typeof token !== 'string' || token.length > 4096) throw invalid('not a token');
      const parts = token.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid('malformed');
      const [encoded, signaturePart] = parts as [string, string];
      const signature = base64UrlDecode(signaturePart);
      if (!signature) throw invalid('malformed');

      // Check the signature with every key before reading any claim.
      let signed = false;
      for (const key of await getKeys()) {
        if (timingSafeEqual(await sign(key, encoded), signature)) signed = true;
      }
      if (!signed) throw invalid('the signature does not match: it was changed or signed with another secret');

      const bodyBytes = base64UrlDecode(encoded);
      let body: TokenBody;
      try {
        body = JSON.parse(fromUtf8(bodyBytes ?? new Uint8Array())) as TokenBody;
      } catch {
        throw invalid('malformed');
      }
      if (body?.v !== 1 || typeof body.exp !== 'number' || typeof body.ph !== 'string') throw invalid('unknown format');

      if (now() >= body.exp) {
        throw new GuardrailError(
          'preview_expired',
          `The previewToken expired at ${new Date(body.exp).toISOString()}. Call the preview again for a new token.`,
          { expiredAt: new Date(body.exp).toISOString() },
        );
      }

      const mismatch: string[] = [];
      if (body.act !== binding.action) mismatch.push('action');
      if (body.res !== binding.resource) mismatch.push('resource');
      if (body.sub !== binding.actor) mismatch.push('actor');
      if (!timingSafeEqual(utf8(body.ph), utf8(await hashJson(binding.payload ?? null)))) mismatch.push('payload');
      if (mismatch.length) {
        throw new GuardrailError(
          'preview_mismatch',
          `The previewToken was issued for a different ${mismatch.join(', ')}. ` +
            'Confirm with exactly the arguments you previewed, or preview the new ones first.',
          { mismatch },
        );
      }

      if (body.sh !== undefined || binding.state !== undefined) {
        const current = binding.state === undefined ? '' : await hashJson(binding.state);
        if (!timingSafeEqual(utf8(body.sh ?? ''), utf8(current))) {
          throw new GuardrailError(
            'preview_stale',
            'The data changed since the preview, so the plan you confirmed is out of date. Preview again and show the new plan.',
          );
        }
      }

      return {
        id: body.jti,
        action: body.act,
        resource: body.res,
        actor: body.sub,
        issuedAt: body.iat,
        expiresAt: body.exp,
      };
    },
  };
}
