import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNotesServer } from '../examples/notes-server.ts';

const SECRET = 'test-secret-that-is-at-least-32-bytes-long';

type Body = Record<string, unknown> & { error?: { code: string; message: string } & Record<string, unknown> };

describe('end to end with the official SDK', () => {
  let client: Client;
  let close: () => Promise<void>;

  before(async () => {
    const { server } = createNotesServer({
      secret: SECRET,
      notes: {
        n1: { title: 'Hello', body: 'First note', status: 'draft' },
        n2: { title: 'Plans', body: 'Second note', status: 'draft' },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-agent', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  after(() => close());

  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; body: Body; text: string }> {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    let body: Body;
    try {
      body = JSON.parse(text) as Body;
    } catch {
      body = {};
    }
    assert.deepEqual(result.structuredContent ?? body, body);
    return { isError: result.isError === true, body, text };
  }

  it('publishes annotations, the guard arguments and the instructions', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(Object.keys(byName).sort(), [
      'notes_delete',
      'notes_get',
      'notes_update',
      'revisions_list',
      'revisions_restore',
    ]);

    assert.equal(byName.notes_get!.annotations?.readOnlyHint, true);
    assert.equal(byName.notes_delete!.annotations?.destructiveHint, true);
    assert.equal(byName.notes_delete!.annotations?.idempotentHint, true);
    assert.equal(byName.notes_update!.annotations?.destructiveHint, false);

    const deleteSchema = byName.notes_delete!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: unknown;
    };
    assert.deepEqual(Object.keys(deleteSchema.properties).sort(), [
      'confirm',
      'dryRun',
      'expectedVersion',
      'id',
      'previewToken',
    ]);
    assert.deepEqual(deleteSchema.required?.sort(), ['expectedVersion', 'id']);
    assert.equal(deleteSchema.additionalProperties, false);

    const text = client.getInstructions() ?? '';
    assert.match(text, /^Notes: read, change and delete notes\./);
    assert.match(text, /pass expectedVersion from that response/);
    assert.match(text, /Deletes and bulk operations \(revisions_restore\): call with dryRun: true first/);
    assert.match(text, /notes_delete: call with dryRun: true first, .* previewToken and confirm: true/);
    assert.match(text, /Updates take a JSON Merge Patch/);
    assert.match(text, /revisions_list → revisions_restore to undo/);
  });

  it('drives dryRun → confirm on a destructive tool', async () => {
    const read = await call('notes_get', { id: 'n2' });
    const version = read.body.version;

    const refused = await call('notes_delete', { id: 'n2', expectedVersion: version });
    assert.equal(refused.isError, true);
    assert.equal(refused.body.error!.code, 'confirmation_required');

    const dry = await call('notes_delete', { id: 'n2', expectedVersion: version, dryRun: true });
    assert.equal(dry.isError, false);
    assert.deepEqual(dry.body.plan, { deletes: { id: 'n2', title: 'Plans', version } });
    assert.equal((await call('notes_get', { id: 'n2' })).isError, false, 'a dry run changes nothing');

    const done = await call('notes_delete', {
      id: 'n2',
      expectedVersion: version,
      previewToken: dry.body.previewToken,
      confirm: true,
    });
    assert.equal(done.isError, false);
    assert.equal(done.body.deleted, 'n2');
    assert.equal((await call('notes_get', { id: 'n2' })).body.error!.code, 'not_found');
  });

  it('rejects a bad preview token', async () => {
    const { version } = (await call('notes_get', { id: 'n1' })).body;
    const dry = await call('notes_delete', { id: 'n1', expectedVersion: version, dryRun: true });
    const token = String(dry.body.previewToken);
    const tampered = `${token.slice(0, -4)}${token.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;

    const bad = await call('notes_delete', {
      id: 'n1',
      expectedVersion: version,
      previewToken: tampered,
      confirm: true,
    });
    assert.equal(bad.isError, true);
    assert.equal(bad.body.error!.code, 'preview_invalid');

    const otherNote = await call('notes_delete', {
      id: 'n2',
      expectedVersion: version,
      previewToken: token,
      confirm: true,
    });
    assert.equal(otherNote.body.error!.code, 'preview_mismatch');
    assert.deepEqual(otherNote.body.error!.mismatch, ['resource', 'payload']);
    assert.equal((await call('notes_get', { id: 'n1' })).isError, false);
  });

  it('refuses a stale version with the current one', async () => {
    const { version } = (await call('notes_get', { id: 'n1' })).body;
    const first = await call('notes_update', { id: 'n1', expectedVersion: version, patch: { title: 'Hello again' } });
    assert.equal(first.isError, false);
    assert.notEqual(first.body.version, version);

    const stale = await call('notes_update', { id: 'n1', expectedVersion: version, patch: { title: 'Lost update' } });
    assert.equal(stale.isError, true);
    assert.equal(stale.body.error!.code, 'version_conflict');
    assert.equal(stale.body.error!.currentVersion, first.body.version);
    assert.equal(((await call('notes_get', { id: 'n1' })).body.note as { title: string }).title, 'Hello again');
  });

  it('teaches valid fields and options', async () => {
    const { version } = (await call('notes_get', { id: 'n1' })).body;
    const field = await call('notes_update', { id: 'n1', expectedVersion: version, patch: { titel: 'x' } });
    assert.equal(field.body.error!.code, 'unknown_field');
    assert.deepEqual(field.body.error!.knownFields, ['title', 'body', 'status']);

    const option = await call('notes_update', { id: 'n1', expectedVersion: version, patch: { status: 'live' } });
    assert.equal(option.body.error!.code, 'invalid_option');
    assert.deepEqual(option.body.error!.validOptions, ['draft', 'published']);

    const argument = await call('notes_update', { id: 'n1', expectedVersion: version, pach: {} });
    assert.equal(argument.isError, true);
    assert.match(
      argument.text,
      /Unknown field: "pach"\. Known fields: "id", "patch", "expectedVersion"\. Did you mean "pach" → "patch"\?/,
    );

    const missing = await call('notes_update', { id: 'n1', patch: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /expectedVersion is required/);
  });

  it('undoes a change through the revision log', async () => {
    const before = (await call('notes_get', { id: 'n1' })).body;
    await call('notes_update', {
      id: 'n1',
      expectedVersion: before.version,
      patch: { body: null, status: 'published' },
    });

    const { revisions } = (await call('revisions_list', { resourceType: 'note', resourceId: 'n1' })).body as {
      revisions: Array<{ id: string; operation: string }>;
    };
    const latest = revisions[0]!;
    assert.equal(latest.operation, 'update');

    const dry = await call('revisions_restore', { revisionId: latest.id, dryRun: true });
    assert.deepEqual((dry.body.plan as { restores: unknown }).restores, before.note);
    const restored = await call('revisions_restore', { revisionId: latest.id, confirm: true });
    assert.equal(restored.isError, false);
    assert.deepEqual((await call('notes_get', { id: 'n1' })).body.note, before.note);

    // The deleted note comes back from its delete revision.
    const deletes = (await call('revisions_list', { resourceId: 'n2' })).body.revisions as Array<{
      id: string;
      operation: string;
    }>;
    assert.equal(deletes[0]!.operation, 'delete');
    await call('revisions_restore', { revisionId: deletes[0]!.id, confirm: true });
    assert.equal(((await call('notes_get', { id: 'n2' })).body.note as { title: string }).title, 'Plans');

    const unknownType = await call('revisions_list', { resourceType: 'page' });
    assert.equal(unknownType.isError, true);
  });
});
