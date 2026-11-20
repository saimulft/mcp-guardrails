import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkVersion,
  createMemoryStore,
  createRevisionLog,
  deleteIfUnchanged,
  isGuardrailError,
  sameVersion,
  updateIfUnchanged,
} from '../src/index.ts';

type Doc = { name: string };

function code(expected: string, check?: (details: Record<string, unknown>) => void) {
  return (error: unknown) => {
    assert.ok(isGuardrailError(error), 'expected a GuardrailError');
    assert.equal(error.code, expected);
    check?.(error.details);
    return true;
  };
}

describe('version checks', () => {
  it('compares timestamps by instant and numbers with their strings', () => {
    assert.ok(sameVersion('2025-01-02T03:04:05Z', '2025-01-02T03:04:05.000Z'));
    assert.ok(sameVersion(3, '3'));
    assert.ok(!sameVersion(3, 4));
    assert.ok(!sameVersion('etag-a', 'etag-b'));
    assert.ok(sameVersion(null, undefined));
  });

  it('throws version_required, version_conflict or invalid_arguments', () => {
    assert.throws(() => checkVersion(1, undefined), code('version_required'));
    checkVersion(1, undefined, { required: false });
    checkVersion(1, 1);
    assert.throws(
      () => checkVersion(2, 1, { resource: 'note "n1"' }),
      code('version_conflict', (details) => {
        assert.equal(details.currentVersion, 2);
        assert.equal(details.expectedVersion, 1);
      }),
    );
    assert.throws(() => checkVersion(1, { $ne: null }), code('invalid_arguments'));
  });
});

describe('compare-and-set', () => {
  it('lets exactly one of two writers with the same version win', async () => {
    const store = createMemoryStore<Doc>({ t1: { name: 'Welcome' } });
    const { version } = (await store.get('t1'))!;
    const results = await Promise.allSettled([
      updateIfUnchanged(store, { id: 't1', expectedVersion: version, update: () => ({ name: 'A' }) }),
      updateIfUnchanged(store, { id: 't1', expectedVersion: version, update: () => ({ name: 'B' }) }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    code('version_conflict')(lost[0]!.reason);

    // A third write with the stale version is refused and changes nothing.
    const before = (await store.get('t1'))!;
    await assert.rejects(
      updateIfUnchanged(store, { id: 't1', expectedVersion: version, update: () => ({ name: 'C' }) }),
      code('version_conflict', (details) => assert.equal(details.currentVersion, before.version)),
    );
    assert.deepEqual(await store.get('t1'), before);
  });

  it('detects a write that lands between the read and the compare-and-set', async () => {
    const store = createMemoryStore<Doc>({ t1: { name: 'Welcome' } });
    const { version } = (await store.get('t1'))!;
    await assert.rejects(
      updateIfUnchanged(store, {
        id: 't1',
        expectedVersion: version,
        update: async (doc) => {
          await store.compareAndSet('t1', version, { name: 'someone else' });
          return { ...doc, name: 'mine' };
        },
      }),
      code('version_conflict'),
    );
    assert.equal((await store.get('t1'))!.value.name, 'someone else');
  });

  it('records a revision only for the write that succeeded', async () => {
    const store = createMemoryStore<Doc>({ t1: { name: 'Welcome' } });
    const log = createRevisionLog();
    const { version } = (await store.get('t1'))!;
    const revision = { log, resourceType: 'template' };
    await Promise.allSettled([
      updateIfUnchanged(store, { id: 't1', expectedVersion: version, update: () => ({ name: 'A' }), revision }),
      updateIfUnchanged(store, { id: 't1', expectedVersion: version, update: () => ({ name: 'B' }), revision }),
    ]);
    const revisions = await log.list({ resourceType: 'template' });
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]!.operation, 'update');
    assert.deepEqual((await log.get(revisions[0]!.id)).snapshot, { name: 'Welcome' });
  });

  it('requires the version by default and reports missing records as not_found', async () => {
    const store = createMemoryStore<Doc>({ t1: { name: 'Welcome' } });
    await assert.rejects(
      updateIfUnchanged(store, { id: 't1', expectedVersion: undefined, update: (d) => d }),
      code('version_required'),
    );
    const done = await updateIfUnchanged(store, {
      id: 't1',
      expectedVersion: undefined,
      required: false,
      update: () => ({ name: 'B' }),
    });
    assert.equal(done.previous.name, 'Welcome');
    await assert.rejects(
      updateIfUnchanged(store, { id: 'nope', expectedVersion: 1, update: (d) => d }),
      code('not_found'),
    );
  });

  it('deletes with a version check and never reuses versions after a recreate', async () => {
    const store = createMemoryStore<Doc>({ t1: { name: 'Welcome' } });
    const first = (await store.get('t1'))!;
    await assert.rejects(deleteIfUnchanged(store, { id: 't1', expectedVersion: 999 }), code('version_conflict'));
    const deleted = await deleteIfUnchanged(store, { id: 't1', expectedVersion: first.version });
    assert.equal(deleted.value, null);
    assert.equal(await store.get('t1'), undefined);
    const created = await store.compareAndSet('t1', null, { name: 'Again' });
    assert.ok(created.ok && created.version !== first.version);
    assert.deepEqual(await store.compareAndSet('t1', null, { name: 'Twice' }), { ok: false });
  });
});
