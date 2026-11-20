import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryStore, createRevisionLog, isGuardrailError, updateIfUnchanged } from '../src/index.ts';

type Sender = { name: string; smtpPass: string; settings: { apiKey: string; region: string }; token: string | null };

describe('revision log', () => {
  it('caps the history per resource', async () => {
    const log = createRevisionLog({ maxPerResource: 3 });
    for (let i = 1; i <= 5; i++) {
      await log.record({ resourceType: 'note', resourceId: 'n1', operation: 'update', snapshot: { n: i } });
    }
    await log.record({ resourceType: 'note', resourceId: 'n2', operation: 'update', snapshot: { n: 0 } });
    const n1 = await log.list({ resourceType: 'note', resourceId: 'n1' });
    assert.equal(n1.length, 3);
    const kept = await Promise.all(n1.map((r) => log.get(r.id)));
    assert.deepEqual(
      kept.map((r) => r.snapshot),
      [{ n: 5 }, { n: 4 }, { n: 3 }],
    );
    assert.equal((await log.list({ resourceId: 'n2' })).length, 1);
  });

  it('keeps 30 revisions by default and clamps list limits', async () => {
    const log = createRevisionLog();
    for (let i = 0; i < 35; i++) {
      await log.record({ resourceType: 'note', resourceId: 'n1', operation: 'update', snapshot: { i } });
    }
    assert.equal((await log.list()).length, 20);
    assert.equal((await log.list({ limit: 1000 })).length, 30);
    assert.equal((await log.list({ limit: -5 })).length, 20);
  });

  it('redacts secret fields on the way out, at any depth, but keeps them for restore', async () => {
    const senders = createMemoryStore<Sender>({
      s1: { name: 'Sales', smtpPass: 'hunter2', settings: { apiKey: 'sk-live', region: 'eu' }, token: null },
    });
    const log = createRevisionLog({ redact: ['smtpPass', 'apiKey', 'token', /^private/] });
    const { version } = (await senders.get('s1'))!;
    const saved = await updateIfUnchanged(senders, {
      id: 's1',
      expectedVersion: version,
      update: (s) => ({ ...s, name: 'Sales EU', smtpPass: 'changed' }),
      revision: { log, resourceType: 'sender' },
    });

    const revision = await log.get(saved.revisionId!);
    assert.deepEqual(revision.snapshot, {
      name: 'Sales',
      smtpPass: '[redacted]',
      settings: { apiKey: '[redacted]', region: 'eu' },
      token: null,
    });
    assert.deepEqual(log.redact({ privateKey: 'x', nested: [{ apiKey: 'y' }] }), {
      privateKey: '[redacted]',
      nested: [{ apiKey: '[redacted]' }],
    });

    await log.restore(saved.revisionId!, { store: senders });
    assert.equal((await senders.get('s1'))!.value.smtpPass, 'hunter2');
  });

  it('restores a revision, records the replaced value, and can undo the restore', async () => {
    const notes = createMemoryStore<{ title: string }>({ n1: { title: 'v1' } });
    const log = createRevisionLog();
    const first = await updateIfUnchanged(notes, {
      id: 'n1',
      expectedVersion: (await notes.get('n1'))!.version,
      update: () => ({ title: 'v2' }),
      revision: { log, resourceType: 'note' },
    });

    const restored = await log.restore(first.revisionId!, { store: notes, actor: 'user-1' });
    assert.equal((await notes.get('n1'))!.value.title, 'v1');
    assert.equal(restored.version, (await notes.get('n1'))!.version);
    const undoRevision = await log.get(restored.revisionId);
    assert.equal(undoRevision.operation, 'restore');
    assert.equal(undoRevision.actor, 'user-1');
    assert.deepEqual(undoRevision.snapshot, { title: 'v2' });

    await log.restore(restored.revisionId, { store: notes });
    assert.equal((await notes.get('n1'))!.value.title, 'v2');
  });

  it('brings back a deleted resource and deletes one whose snapshot is null', async () => {
    const notes = createMemoryStore<{ title: string }>();
    const log = createRevisionLog();
    const created = await log.record({ resourceType: 'note', resourceId: 'n1', operation: 'create', snapshot: null });
    await notes.compareAndSet('n1', null, { title: 'new' });
    const deletedSnapshot = await log.record({
      resourceType: 'note',
      resourceId: 'n1',
      operation: 'delete',
      snapshot: { title: 'new' },
    });

    const undoCreate = await log.restore(created.id, { store: notes });
    assert.equal(undoCreate.deleted, true);
    assert.equal(await notes.get('n1'), undefined);

    await log.restore(deletedSnapshot.id, { store: notes });
    assert.deepEqual((await notes.get('n1'))!.value, { title: 'new' });
  });

  it('keeps scopes apart', async () => {
    const log = createRevisionLog();
    const a = await log.record({
      resourceType: 'note',
      resourceId: 'n1',
      operation: 'update',
      snapshot: {},
      scope: 'tenant-a',
    });
    await log.record({ resourceType: 'note', resourceId: 'n1', operation: 'update', snapshot: {}, scope: 'tenant-b' });
    assert.equal((await log.list({ scope: 'tenant-a' })).length, 1);
    await assert.rejects(
      log.get(a.id, { scope: 'tenant-b' }),
      (error) => isGuardrailError(error) && error.code === 'not_found',
    );
    assert.equal((await log.get(a.id, { scope: 'tenant-a' })).id, a.id);
  });
});
