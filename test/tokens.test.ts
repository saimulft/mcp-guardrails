import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPreviewTokens, isGuardrailError } from '../src/index.ts';
import type { PreviewBinding } from '../src/index.ts';

const SECRET = 'test-secret-that-is-at-least-32-bytes-long';
const binding: PreviewBinding = {
  action: 'notes_delete',
  resource: 'n1',
  actor: 'workspace-1:user-1',
  payload: { id: 'n1', expectedVersion: 3 },
};

async function rejects(promise: Promise<unknown>, code: string, check?: (details: Record<string, unknown>) => void) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isGuardrailError(error), 'expected a GuardrailError');
    assert.equal(error.code, code);
    check?.(error.details);
    return true;
  });
}

describe('preview tokens', () => {
  it('verifies a token for the same binding and returns its claims', async () => {
    const tokens = createPreviewTokens({ secret: SECRET });
    const issued = await tokens.issue(binding);
    const claims = await tokens.verify(issued.token, binding);
    assert.equal(claims.action, 'notes_delete');
    assert.equal(claims.resource, 'n1');
    assert.equal(claims.actor, 'workspace-1:user-1');
    assert.equal(new Date(claims.expiresAt).toISOString(), issued.expiresAt);
    assert.match(claims.id, /^[0-9a-f-]{36}$/);
  });

  it('hashes the payload canonically, so key order does not matter', async () => {
    const tokens = createPreviewTokens({ secret: SECRET });
    const { token } = await tokens.issue(binding);
    await tokens.verify(token, { ...binding, payload: { expectedVersion: 3, id: 'n1' } });
  });

  it('refuses a tampered payload or signature as preview_invalid', async () => {
    const tokens = createPreviewTokens({ secret: SECRET });
    const { token } = await tokens.issue(binding);
    const [body, signature] = token.split('.') as [string, string];

    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    claims.res = 'n2';
    const forgedBody = Buffer.from(JSON.stringify(claims)).toString('base64url');
    await rejects(tokens.verify(`${forgedBody}.${signature}`, { ...binding, resource: 'n2' }), 'preview_invalid');

    const flipped = signature.slice(0, -2) + (signature.endsWith('AA') ? 'BB' : 'AA');
    await rejects(tokens.verify(`${body}.${flipped}`, binding), 'preview_invalid');
    await rejects(tokens.verify('not-a-token', binding), 'preview_invalid');
    await rejects(tokens.verify(`${body}.${signature}.extra`, binding), 'preview_invalid');
  });

  it('refuses a token signed with another secret', async () => {
    const other = createPreviewTokens({ secret: 'a-completely-different-secret-of-32-bytes' });
    const tokens = createPreviewTokens({ secret: SECRET });
    const { token } = await other.issue(binding);
    await rejects(tokens.verify(token, binding), 'preview_invalid');
  });

  it('refuses an expired token as preview_expired', async () => {
    let now = 1_000_000;
    const tokens = createPreviewTokens({ secret: SECRET, ttlMs: 60_000, now: () => now });
    const { token, expiresAt } = await tokens.issue(binding);
    now += 59_999;
    await tokens.verify(token, binding);
    now += 1;
    await rejects(tokens.verify(token, binding), 'preview_expired', (details) => {
      assert.equal(details.expiredAt, expiresAt);
    });
  });

  it('refuses a token for another resource, actor, action or payload as preview_mismatch', async () => {
    const tokens = createPreviewTokens({ secret: SECRET });
    const { token } = await tokens.issue(binding);
    const mismatch = (expected: string[]) => (details: Record<string, unknown>) =>
      assert.deepEqual(details.mismatch, expected);

    await rejects(tokens.verify(token, { ...binding, resource: 'n2' }), 'preview_mismatch', mismatch(['resource']));
    await rejects(
      tokens.verify(token, { ...binding, actor: 'workspace-2:user-1' }),
      'preview_mismatch',
      mismatch(['actor']),
    );
    await rejects(
      tokens.verify(token, { ...binding, action: 'notes_update' }),
      'preview_mismatch',
      mismatch(['action']),
    );
    await rejects(
      tokens.verify(token, { ...binding, payload: { id: 'n1', expectedVersion: 4 } }),
      'preview_mismatch',
      mismatch(['payload']),
    );
  });

  it('refuses a token whose bound state changed as preview_stale', async () => {
    const tokens = createPreviewTokens({ secret: SECRET });
    const { token } = await tokens.issue({ ...binding, state: { recipients: 120 } });
    await tokens.verify(token, { ...binding, state: { recipients: 120 } });
    await rejects(tokens.verify(token, { ...binding, state: { recipients: 121 } }), 'preview_stale');
    await rejects(tokens.verify(token, binding), 'preview_stale');
  });

  it('verifies with every rotated secret and signs with the first', async () => {
    const old = createPreviewTokens({ secret: SECRET });
    const rotated = createPreviewTokens({ secret: ['the-new-secret-that-is-32-bytes-or-more', SECRET] });
    const { token } = await old.issue(binding);
    await rotated.verify(token, binding);
    const fresh = await rotated.issue(binding);
    await rejects(old.verify(fresh.token, binding), 'preview_invalid');
  });

  it('rejects short secrets and bad lifetimes at creation', () => {
    assert.throws(() => createPreviewTokens({ secret: 'short' }), /at least 32 bytes/);
    assert.throws(() => createPreviewTokens({ secret: [] }), /at least one secret/);
    assert.throws(() => createPreviewTokens({ secret: SECRET, ttlMs: 0 }), /ttlMs/);
    assert.equal(createPreviewTokens({ secret: new Uint8Array(32) }).ttlMs, 15 * 60 * 1000);
  });
});
