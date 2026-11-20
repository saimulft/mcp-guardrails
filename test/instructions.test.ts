import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPreviewTokens, defineTool, instructions } from '../src/index.ts';

const tokens = createPreviewTokens({ secret: 'test-secret-that-is-at-least-32-bytes-long', ttlMs: 10 * 60 * 1000 });
const run = () => ({});

describe('instructions', () => {
  it('writes the rules the tools use', () => {
    const tools = [
      defineTool({ name: 'notes_get', kind: 'read', description: '', run }),
      defineTool({ name: 'notes_update', kind: 'write', description: '', version: true, run }),
      defineTool({ name: 'notes_bulk_archive', kind: 'destructive', description: '', run }),
      defineTool({ name: 'notes_delete', kind: 'destructive', description: '', tokens, actor: () => 'u', run }),
      defineTool({
        name: 'campaigns_send',
        kind: 'write',
        description: '',
        confirm: 'preview',
        previewTool: 'campaigns_preview',
        tokens,
        actor: () => 'u',
        run,
      }),
    ];
    const text = instructions({
      intro: 'Notes server.',
      tools,
      mergePatch: true,
      revisions: true,
      rules: ['Be brief.'],
    });
    assert.equal(
      text,
      `Notes server.

Rules:
- Call *_get before an update and pass expectedVersion from that response. If the data changed in the meantime the update is refused with version_conflict and the current version: read again and redo the change.
- Updates take a JSON Merge Patch: send only the fields that change; nested objects merge; lists replace (send the whole list); null clears a field.
- Deletes and bulk operations (notes_bulk_archive): call with dryRun: true first, show the user the plan, then call again with confirm: true once they agree.
- notes_delete: call with dryRun: true first, show the user the plan, then call again with the same arguments plus previewToken and confirm: true.
- campaigns_send: call campaigns_preview first, then pass its previewToken + confirm: true.
- Tokens expire after 10 minutes and only work for the arguments that were previewed; preview again after any change.
- Never invent fields or values: unknown fields and options are rejected with the valid options.
- Every change saves a revision: revisions_list → revisions_restore to undo.
- A refused call returns an error that names the problem and how to fix it. Follow the message; never repeat a refused call unchanged.
- Be brief.`,
    );
  });

  it('can be written without tools, from flags', () => {
    const text = instructions({
      version: 'expectedUpdatedAt',
      confirm: true,
      preview: true,
      errors: false,
      unknownFields: false,
    });
    assert.match(text, /^Rules:\n- Call \*_get before an update and pass expectedUpdatedAt/);
    assert.match(text, /- Deletes and bulk operations: call with dryRun: true first/);
    assert.match(text, /- Tools that take a previewToken: call with dryRun: true first/);
    assert.doesNotMatch(text, /Never invent/);
    assert.equal(instructions({ unknownFields: false, errors: false }), '');
  });
});
