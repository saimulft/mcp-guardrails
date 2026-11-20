import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPreviewTokens, defineTool, toolResult } from '../src/index.ts';
import type { ToolResult } from '../src/index.ts';

const tokens = createPreviewTokens({ secret: 'test-secret-that-is-at-least-32-bytes-long' });
type Ctx = { user: string };
const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true);
  return (result.structuredContent as { error: { code: string; message: string } & Record<string, unknown> }).error;
};

describe('defineTool annotations', () => {
  it('maps read, write and destructive to the MCP hints', () => {
    const run = () => ({});
    assert.deepEqual(defineTool({ name: 'a_get', kind: 'read', description: '', run }).annotations, {
      readOnlyHint: true,
      openWorldHint: false,
    });
    assert.deepEqual(defineTool({ name: 'a_update', kind: 'write', description: '', run }).annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    assert.deepEqual(
      defineTool({ name: 'a_delete', kind: 'destructive', description: '', idempotent: true, title: 'Delete', run })
        .annotations,
      { title: 'Delete', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    );
    assert.equal(
      defineTool({ name: 'web', kind: 'read', description: '', openWorld: true, run }).annotations.openWorldHint,
      true,
    );
  });

  it('picks the confirm mode and control fields from the definition', () => {
    const run = () => ({});
    const actor = (ctx: Ctx) => ctx.user;
    const names = (tool: { controlFields: readonly { name: string }[] }) => tool.controlFields.map((f) => f.name);

    const write = defineTool({ name: 'w', kind: 'write', description: '', version: true, run });
    assert.equal(write.confirm, 'none');
    assert.deepEqual(names(write), ['expectedVersion']);

    const flag = defineTool({ name: 'f', kind: 'destructive', description: '', run });
    assert.equal(flag.confirm, 'flag');
    assert.deepEqual(names(flag), ['dryRun', 'confirm']);

    const preview = defineTool<{ id: string }, Ctx>({
      name: 'p',
      kind: 'destructive',
      description: '',
      tokens,
      actor,
      version: { field: 'expectedUpdatedAt', required: false },
      run,
    });
    assert.equal(preview.confirm, 'preview');
    assert.deepEqual(names(preview), ['dryRun', 'confirm', 'previewToken', 'expectedUpdatedAt']);
    assert.deepEqual(preview.version, { field: 'expectedUpdatedAt', required: false });

    const separate = defineTool({
      name: 's',
      kind: 'write',
      description: '',
      confirm: 'preview',
      previewTool: 's_preview',
      tokens,
      actor,
      run,
    });
    assert.deepEqual(names(separate), ['confirm', 'previewToken']);
  });

  it('refuses inconsistent definitions', () => {
    const run = () => ({});
    assert.throws(() => defineTool({ name: 'r', kind: 'read', description: '', version: true, run }), /read tools/);
    assert.throws(
      () => defineTool({ name: 'p', kind: 'write', description: '', confirm: 'preview', run }),
      /needs tokens/,
    );
    assert.throws(() => defineTool({ name: 'p', kind: 'destructive', description: '', tokens, run }), /needs actor/);
    assert.throws(() => defineTool({ name: 'x', kind: 'remove' as 'read', description: '', run }), /kind must be/);
  });
});

describe('guarded calls', () => {
  const ctx: Ctx = { user: 'u1' };
  let deleted: string[] = [];
  const remove = defineTool<{ id: string; expectedVersion?: number }, Ctx>({
    name: 'notes_delete',
    kind: 'destructive',
    description: 'Delete a note.',
    tokens,
    actor: (c) => c.user,
    version: true,
    fields: ['id'],
    plan: ({ id }) => ({ deletes: id }),
    run: ({ id }, _ctx, guard) => {
      assert.equal(guard.confirmed, true);
      assert.equal(guard.preview?.resource, id);
      deleted.push(id);
      return { deleted: id, version: guard.expectedVersion };
    },
  });

  it('runs dryRun → confirm with the preview token', async () => {
    deleted = [];
    const dry = await remove.call({ id: 'n1', expectedVersion: 3, dryRun: true }, ctx);
    assert.equal(dry.isError, undefined);
    const body = dry.structuredContent as { dryRun: boolean; plan: unknown; previewToken: string; next: string };
    assert.equal(body.dryRun, true);
    assert.deepEqual(body.plan, { deletes: 'n1' });
    assert.match(body.next, /previewToken and confirm: true/);
    assert.deepEqual(deleted, []);

    const done = await remove.call(
      { id: 'n1', expectedVersion: 3, previewToken: body.previewToken, confirm: true },
      ctx,
    );
    assert.deepEqual(done.structuredContent, { deleted: 'n1', version: 3 });
    assert.equal(done.content[0]!.text, JSON.stringify({ deleted: 'n1', version: 3 }));
    assert.deepEqual(deleted, ['n1']);
  });

  it('teaches the next step when a guard argument is missing or wrong', async () => {
    const dry = await remove.call({ id: 'n1', expectedVersion: 3, dryRun: true }, ctx);
    const { previewToken } = dry.structuredContent as { previewToken: string };

    assert.equal(errorOf(await remove.call({ id: 'n1', expectedVersion: 3 }, ctx)).code, 'confirmation_required');
    assert.equal(
      errorOf(await remove.call({ id: 'n1', expectedVersion: 3, confirm: true }, ctx)).code,
      'preview_required',
    );
    assert.equal(errorOf(await remove.call({ id: 'n1', confirm: true, previewToken }, ctx)).code, 'version_required');
    assert.equal(
      errorOf(await remove.call({ id: 'n1', expectedVersion: 3, confirm: 'yes' }, ctx)).code,
      'invalid_arguments',
    );
    assert.equal(
      errorOf(await remove.call({ id: 'n1', expectedVersion: 3, confirm: true, previewToken }, { user: 'u2' })).code,
      'preview_mismatch',
    );
    assert.equal(
      errorOf(await remove.call({ id: 'n2', expectedVersion: 3, confirm: true, previewToken }, ctx)).code,
      'preview_mismatch',
    );
    assert.equal(
      errorOf(await remove.call({ id: 'n1', expectedVersion: 4, confirm: true, previewToken }, ctx)).code,
      'preview_mismatch',
    );

    const unknown = errorOf(await remove.call({ id: 'n1', expectedVersion: 3, dryrun: true }, ctx));
    assert.equal(unknown.code, 'unknown_field');
    assert.deepEqual(unknown.knownFields, ['id', 'dryRun', 'confirm', 'previewToken', 'expectedVersion']);
    assert.match(unknown.message, /Did you mean "dryrun" → "dryRun"/);
  });

  it('requires confirm: true in flag mode and offers a plan', async () => {
    const tool = defineTool({
      name: 'bulk_archive',
      kind: 'destructive',
      description: '',
      run: () => ({ archived: 2 }),
    });
    const refused = errorOf(await tool.call({}, undefined));
    assert.equal(refused.code, 'confirmation_required');
    assert.match(refused.message, /dryRun: true/);
    const plan = await tool.call({ dryRun: true, ids: ['a'] }, undefined);
    assert.deepEqual(plan.structuredContent, {
      dryRun: true,
      plan: { tool: 'bulk_archive', arguments: { ids: ['a'] } },
      next: 'Show the user this plan. To apply it, call bulk_archive again with the same arguments and confirm: true.',
    });
    assert.deepEqual((await tool.call({ confirm: true }, undefined)).structuredContent, { archived: 2 });
  });

  it('issues tokens from a separate preview tool', async () => {
    const send = defineTool<{ id: string }, Ctx>({
      name: 'campaigns_send',
      kind: 'write',
      description: '',
      confirm: 'preview',
      previewTool: 'campaigns_preview',
      tokens,
      actor: (c) => c.user,
      bind: ({ id }) => ({ id }),
      fingerprint: () => ({ recipients: 120 }),
      plan: () => ({ recipients: 120 }),
      run: () => ({ sent: true }),
    });
    const refused = errorOf(await send.call({ id: 'c1', confirm: true }, ctx));
    assert.equal(refused.code, 'preview_required');
    assert.match(refused.message, /Call campaigns_preview first/);
    const { previewToken, plan } = await send.preview({ id: 'c1' }, ctx);
    assert.deepEqual(plan, { recipients: 120 });
    assert.deepEqual((await send.call({ id: 'c1', confirm: true, previewToken }, ctx)).structuredContent, {
      sent: true,
    });
  });

  it('shows GuardrailErrors to the agent and hides unexpected errors', async () => {
    const logged: unknown[] = [];
    const tool = defineTool({
      name: 'boom',
      kind: 'read',
      description: '',
      run: () => {
        throw new Error('database password is hunter2');
      },
      onError: (error) => void logged.push(error),
    });
    const error = errorOf(await tool.call({}, undefined));
    assert.deepEqual(error, {
      code: 'internal_error',
      message: 'Unexpected server error. Try again; if it repeats, report it.',
    });
    assert.equal(logged.length, 1);
    assert.equal(errorOf(await tool.call('not an object', undefined)).code, 'invalid_arguments');
  });

  it('wraps results into the MCP shape', async () => {
    const tool = (value: unknown) => defineTool({ name: 't', kind: 'read', description: '', run: () => value });
    assert.deepEqual((await tool(undefined).call({}, undefined)).structuredContent, { ok: true });
    assert.deepEqual((await tool([1, 2]).call({}, undefined)).structuredContent, { result: [1, 2] });
    const custom = toolResult({ a: 1 });
    assert.equal(await tool(custom).call({}, undefined), custom);
  });
});
