# mcp-guardrails

MCP security for servers that let AI agents change data: safety rails with dry run, confirm, preview tokens and undo.

[![npm version](https://img.shields.io/npm/v/mcp-guardrails)](https://www.npmjs.com/package/mcp-guardrails)
[![license](https://img.shields.io/npm/l/mcp-guardrails)](https://www.npmjs.com/package/mcp-guardrails)
[![node](https://img.shields.io/node/v/mcp-guardrails)](https://www.npmjs.com/package/mcp-guardrails)

Guide, examples and FAQ: https://oss.saimulislam.com/mcp-guardrails/

The same guardrails protect the MCP servers of [Sitessa](https://sitessa.com) and the [Bundlewise CRM](https://crm.bundlewise.app).

## The problem

An agent with write tools behaves like a fast, confident new hire. It retries calls that already succeeded, guesses field names, edits a record it read ten minutes ago, and runs a delete on the first try because nothing asked it to look first. The official MCP SDKs give you tool annotations, which are hints, but no dry-run and confirm flow, no preview tokens, no version checks and no undo. Every server ends up writing those itself.

mcp-guardrails is that layer, extracted from production servers:

- **One definition per tool.** `kind: 'read' | 'write' | 'destructive'` sets the MCP annotations and the guard.
- **Dry run, then confirm.** Destructive tools return a plan first and only act on `confirm: true`.
- **Signed preview tokens.** The confirm call must carry an HMAC token bound to the same action, resource, actor and arguments. Tokens expire.
- **Optimistic concurrency.** `expectedVersion` checks with an atomic compare-and-set, and a conflict error that carries the current version.
- **Revisions with undo.** A snapshot before each change, capped history, secret fields redacted, restore.
- **Errors that teach.** Unknown fields and invalid options come back with the valid ones, and every refusal says what to do next.
- **Instructions text.** `instructions()` writes the rules for the agent from the tools you defined.

The core has no runtime dependencies and uses WebCrypto, so it runs on Node 20+ and on edge runtimes such as Cloudflare Workers. Results use the MCP shape, so it fits any server. An optional `mcp-guardrails/sdk` entry point wires it into the official TypeScript SDK.

## Install

```sh
npm install mcp-guardrails
```

For the official SDK integration, also install its peer dependencies:

```sh
npm install @modelcontextprotocol/sdk zod
```

`mcp-guardrails/sdk` needs `@modelcontextprotocol/sdk` 1.32 or later and zod 4. The core (`mcp-guardrails`) needs neither.

## A complete server

A notes server with every guardrail on: a read tool, a versioned merge-patch update, a delete that needs a preview token, and undo through the revision log.

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  assertKnownFields,
  assertOption,
  createMemoryStore,
  createPreviewTokens,
  createRevisionLog,
  deleteIfUnchanged,
  instructions,
  jsonMergePatch,
  notFound,
  updateIfUnchanged,
} from 'mcp-guardrails';
import { defineTool, registerTools, revisionTools } from 'mcp-guardrails/sdk';
import type { ToolExtra } from 'mcp-guardrails/sdk';

type Note = { title: string; body: string; status: 'draft' | 'published' };
const NOTE_FIELDS = ['title', 'body', 'status'];
const STATUSES = ['draft', 'published'] as const;

const notes = createMemoryStore<Note>({ n1: { title: 'Hello', body: 'First note', status: 'draft' } });
const revisions = createRevisionLog();
const tokens = createPreviewTokens({ secret: process.env.MCP_PREVIEW_SECRET! }); // 32+ bytes
// Who is calling: your user (and tenant) id from the auth info. Over stdio there is one local user.
const actor = (extra: ToolExtra) => String(extra.authInfo?.extra?.userId ?? 'local');

const notesGet = defineTool({
  name: 'notes_get',
  kind: 'read',
  description: 'Get a note with its version.',
  input: { id: z.string() },
  async run({ id }) {
    const note = await notes.get(id);
    if (!note) throw notFound('note', id);
    return { id, version: note.version, note: note.value };
  },
});

const notesUpdate = defineTool({
  name: 'notes_update',
  kind: 'write',
  description: 'Change a note with a JSON Merge Patch of its fields (title, body, status).',
  input: { id: z.string(), patch: z.record(z.string(), z.unknown()) },
  version: true, // adds a required expectedVersion argument
  async run({ id, patch }, extra, guard) {
    assertKnownFields(patch, NOTE_FIELDS, 'patch');
    if (patch.status !== undefined) assertOption('status', patch.status, STATUSES);
    const saved = await updateIfUnchanged(notes, {
      id,
      expectedVersion: guard.expectedVersion,
      update: (note) => jsonMergePatch<Note>(note, patch),
      revision: { log: revisions, resourceType: 'note', actor: actor(extra) },
    });
    return { id, version: saved.version, note: saved.value };
  },
});

const notesDelete = defineTool({
  name: 'notes_delete',
  kind: 'destructive', // with tokens: dryRun → previewToken → confirm
  idempotent: true,
  description: "Delete a note. Needs a dry run and the user's confirmation.",
  input: { id: z.string() },
  version: true,
  tokens,
  actor,
  async plan({ id }) {
    const note = await notes.get(id);
    if (!note) throw notFound('note', id);
    return { deletes: { id, title: note.value.title, version: note.version } };
  },
  async run({ id }, extra, guard) {
    const deleted = await deleteIfUnchanged(notes, {
      id,
      expectedVersion: guard.expectedVersion,
      revision: { log: revisions, resourceType: 'note', actor: actor(extra) },
    });
    return { deleted: id, revisionId: deleted.revisionId };
  },
});

const undo = revisionTools({ log: revisions, stores: { note: notes }, actor });
const tools = [notesGet, notesUpdate, notesDelete, undo.list, undo.restore];

const server = new McpServer(
  { name: 'notes', version: '1.0.0' },
  {
    instructions: instructions({
      intro: 'Notes: read, change and delete notes.',
      tools,
      mergePatch: true,
      revisions: true,
    }),
  },
);
registerTools(server, tools);
await server.connect(new StdioServerTransport());
```

The same server is in [`examples/notes-server.ts`](examples/notes-server.ts), and the end-to-end test drives it with an SDK client.

### What the agent sees

`tools/list` shows the annotations and the guard arguments. `notes_delete` gets `readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false`, and its input schema becomes `{ id, dryRun?, confirm?, previewToken?, expectedVersion }` with `additionalProperties: false`. Each guard argument carries a description that tells the agent how to use it.

A typical call sequence:

```jsonc
// 1. Read first, to get the version.
→ notes_get { "id": "n1" }
← { "id": "n1", "version": 1, "note": { "title": "Hello", "body": "First note", "status": "draft" } }

// 2. A delete without confirmation is refused, with the next step.
→ notes_delete { "id": "n1", "expectedVersion": 1 }
← isError: { "error": { "code": "confirmation_required",
    "message": "notes_delete needs confirm: true. Call notes_delete with dryRun: true first, show the user the plan, then call it again with the same arguments plus previewToken and confirm: true." } }

// 3. The dry run returns the plan and a token. Nothing changes.
→ notes_delete { "id": "n1", "expectedVersion": 1, "dryRun": true }
← { "dryRun": true, "plan": { "deletes": { "id": "n1", "title": "Hello", "version": 1 } },
    "previewToken": "eyJ2IjoxLC…", "expiresAt": "2026-01-01T12:15:00.000Z",
    "next": "Show the user this plan. To apply it, call notes_delete again with the same arguments plus this previewToken and confirm: true (valid until 2026-01-01T12:15:00.000Z)." }

// 4. After the user agrees: same arguments, the token, confirm.
→ notes_delete { "id": "n1", "expectedVersion": 1, "previewToken": "eyJ2IjoxLC…", "confirm": true }
← { "deleted": "n1", "revisionId": "4c0d…" }

// The token only works for what was previewed:
→ notes_delete { "id": "n2", "expectedVersion": 1, "previewToken": "eyJ2IjoxLC…", "confirm": true }
← isError: { "error": { "code": "preview_mismatch", "mismatch": ["resource", "payload"],
    "message": "The previewToken was issued for a different resource, payload. Confirm with exactly the arguments you previewed, or preview the new ones first." } }

// A stale version is refused with the current one.
→ notes_update { "id": "n3", "expectedVersion": 4, "patch": { "title": "New" } }
← isError: { "error": { "code": "version_conflict", "currentVersion": 6, "expectedVersion": 4,
    "message": "note \"n3\" was changed since you read it (current version 6, you sent 4). Read it again, redo your change on the current data, and pass the new version." } }

// A guessed field name comes back with the real ones.
→ notes_update { "id": "n3", "expectedVersion": 6, "patch": { "titel": "New" } }
← isError: { "error": { "code": "unknown_field", "fields": ["titel"], "knownFields": ["title", "body", "status"],
    "didYouMean": { "titel": "title" }, "message": "Unknown field in patch: \"titel\". Known fields: …" } }

// Undo: list revisions, preview the restore, confirm it.
→ revisions_list { "resourceId": "n1" }
← { "revisions": [{ "id": "4c0d…", "resourceType": "note", "resourceId": "n1", "operation": "delete", … }] }
→ revisions_restore { "revisionId": "4c0d…", "dryRun": true }
→ revisions_restore { "revisionId": "4c0d…", "confirm": true }
← { "restoredFrom": "4c0d…", "revisionId": "9a1e…", "resourceType": "note", "resourceId": "n1", "version": 7, "deleted": false }
```

## API reference

### Core: `mcp-guardrails`

| Export                                                                | What it does                                                                                                                                 |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineTool(definition)`                                              | A `GuardedTool`: annotations from `kind`, the guard's arguments, and `call(args, ctx)` that enforces them and returns an MCP result.         |
| `annotationsFor(kind, options?)`                                      | The MCP annotations for a kind, without the rest.                                                                                            |
| `createPreviewTokens({ secret, ttlMs?, now? })`                       | `{ issue(binding), verify(token, binding), ttlMs }`. HMAC-SHA-256 over WebCrypto. Default lifetime 15 minutes.                               |
| `checkVersion(current, expected, options?)`                           | Fast-fail version check: `version_required`, `version_conflict`.                                                                             |
| `updateIfUnchanged(store, options)` / `deleteIfUnchanged(store, opt)` | Read, check `expectedVersion`, write with compare-and-set, optionally record a revision. Returns `{ value, version, previous, revisionId }`. |
| `sameVersion(a, b)`                                                   | Version equality; timestamps compare by instant.                                                                                             |
| `versionConflict(current, expected, resource?)`                       | The `version_conflict` error, for your own write paths.                                                                                      |
| `createMemoryStore(initial?)`                                         | A reference `VersionedStore` in memory.                                                                                                      |
| `createRevisionLog(options?)`                                         | `{ record, list, get, restore, redact }`. Capped history (30 per resource), redaction on output.                                             |
| `createMemoryRevisionStore()`                                         | The reference `RevisionStore` in memory.                                                                                                     |
| `jsonMergePatch(target, patch)`                                       | RFC 7396 JSON Merge Patch. Inputs are not modified.                                                                                          |
| `invalidOption(field, value, options)` / `assertOption(...)`          | `invalid_option` with the valid values and a "did you mean".                                                                                 |
| `unknownField(fields, known, where?)` / `assertKnownFields(...)`      | `unknown_field` with the known fields and suggestions.                                                                                       |
| `confirmationRequired(tool, next?)`, `notFound(resource, id)`         | The other common refusals.                                                                                                                   |
| `GuardrailError`, `isGuardrailError(error)`                           | An error with a `code`, an agent-facing `message` and `details`. Throw it from any handler.                                                  |
| `toolResult(data)`, `toolError(error, options?)`                      | Build MCP results by hand. Unexpected errors become `internal_error` without their message.                                                  |
| `instructions(options)`                                               | The server-instructions text. See [Conventions](#conventions).                                                                               |

#### `defineTool` options

| Option                    | Default                                                                            | Meaning                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `name`, `description`     |                                                                                    | Required.                                                                                                             |
| `kind`                    |                                                                                    | `read`, `write` or `destructive`.                                                                                     |
| `title`                   |                                                                                    | Display name, also in the annotations.                                                                                |
| `idempotent`, `openWorld` | `false`                                                                            | The matching hints.                                                                                                   |
| `confirm`                 | `preview` for destructive with `tokens`, `flag` for other destructive, else `none` | `flag`: `confirm: true` required, `dryRun` returns the plan. `preview`: also a valid `previewToken` from the dry run. |
| `tokens`                  |                                                                                    | From `createPreviewTokens`. Required for `preview`.                                                                   |
| `actor(ctx)`              |                                                                                    | The caller's id the token is bound to. Required for `preview`.                                                        |
| `resource(args)`          | `args.id`                                                                          | The resource the token is bound to.                                                                                   |
| `bind(args)`              | all arguments except `dryRun`, `confirm`, `previewToken`                           | The payload whose hash the token carries.                                                                             |
| `fingerprint(args, ctx)`  |                                                                                    | State the plan depends on (a count, a version). A change gives `preview_stale`.                                       |
| `previewTool`             |                                                                                    | A separate tool issues the token through `tool.preview(args, ctx)`; this tool then has no `dryRun`.                   |
| `version`                 |                                                                                    | `true` or `{ field?: 'expectedVersion', required?: true }`. The value reaches `run` as `guard.expectedVersion`.       |
| `fields`                  |                                                                                    | Known argument names; others get `unknown_field`. The SDK helpers enforce this through the schema instead.            |
| `plan(args, ctx, guard)`  | the tool, resource and arguments                                                   | The dry-run result. Must not change anything.                                                                         |
| `run(args, ctx, guard)`   |                                                                                    | Does the work and returns plain data (sent as JSON text and `structuredContent`).                                     |
| `onError(error, tool)`    | `console.error`, then `internal_error`                                             | Map your own errors to a `GuardrailError` the agent may see.                                                          |

`guard` is `{ tool, expectedVersion?, confirmed, preview? }`, where `preview` holds the verified token claims.

#### Interfaces you implement

```ts
interface VersionedStore<T> {
  get(id: string): Promise<{ value: T; version: string | number } | undefined>;
  // Atomic: write `next` only while the stored version equals `expected`, bump the version in the same write.
  // null means absent on both sides: expected null creates, next null deletes.
  compareAndSet(
    id: string,
    expected: Version | null,
    next: T | null,
  ): Promise<{ ok: true; version: Version | null } | { ok: false }>;
}

interface RevisionStore {
  add(revision: Revision): Promise<void>;
  get(id: string): Promise<Revision | undefined>;
  list(query: { resourceType?; resourceId?; scope?; limit: number }): Promise<Revision[]>; // newest first
  prune(resource: { resourceType; resourceId; scope? }, keep: number): Promise<void>;
}
```

On a SQL database, `compareAndSet` is `UPDATE … SET …, version = version + 1 WHERE id = ? AND version = ?` and checking the affected row count. On MongoDB it is `findOneAndUpdate({ _id, updatedAt: expected }, …)`.

#### Revision log options

| Option             | Default                   | Meaning                                                                       |
| ------------------ | ------------------------- | ----------------------------------------------------------------------------- |
| `store`            | in memory                 | A `RevisionStore`.                                                            |
| `maxPerResource`   | `30`                      | History kept per resource.                                                    |
| `redact`           | `DEFAULT_REDACTED_FIELDS` | Field names (or patterns) shown as `"[redacted]"` by `get` and restore plans. |
| `defaultListLimit` | `20`                      | Page size of `list`.                                                          |
| `maxListLimit`     | `100`                     | Largest page.                                                                 |

Revisions take an optional `scope` (for example the tenant id). Pass the caller's scope to `list`, `get` and `restore` and they only see that scope.

### Official SDK: `mcp-guardrails/sdk`

| Export                                | What it does                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `defineTool(definition)`              | The core `defineTool` plus `input` (a zod shape that types `run`) and optional `output`. The context is the SDK's `extra`.    |
| `registerTools(server, tools)`        | Registers those tools on an `McpServer` with `registerTool`.                                                                  |
| `revisionTools({ log, stores, ... })` | `revisions_list` and `revisions_restore` for a revision log. Options: `scope(extra)`, `actor(extra)`, `tokens`, `names`.      |
| `toolConfig(tool, { input, output })` | The `registerTool` config: description, annotations, and the input schema with the guard's arguments, as a strict zod object. |
| `toolHandler(tool)`                   | The `registerTool` callback.                                                                                                  |
| `inputSchema(tool, input)`            | The strict input schema alone.                                                                                                |

Define tools before creating the server, so `instructions({ tools })` can describe them: the SDK takes instructions in the `McpServer` constructor.

## Conventions

These are the rules agents learn, and what enforces them:

| Rule                                                                      | Enforced by                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------- |
| Call `*_get` before `*_update`; pass `expectedVersion` from the response. | `version: true`, `updateIfUnchanged`                      |
| Deletes and bulk operations: `dryRun: true` first, then `confirm: true`.  | `confirm: 'flag'`                                         |
| Call the preview first, then pass `previewToken` + `confirm: true`.       | `confirm: 'preview'`, `tokens`                            |
| Unknown fields are rejected with the valid options.                       | strict input schemas, `assertKnownFields`, `assertOption` |
| Updates take a JSON Merge Patch; pass `expectedVersion`.                  | `jsonMergePatch`                                          |
| `revisions_list` → `revisions_restore` to undo.                           | `createRevisionLog`, `revisionTools`                      |

`instructions()` writes them from the tools you pass, so the text always matches what the server enforces. The version field name, the tools that need a dry run or a preview token, and the token lifetime come from the tool definitions; `mergePatch` and `revisions` are switched on by you. For the server above it returns:

```text
Notes: read, change and delete notes.

Rules:
- Call *_get before an update and pass expectedVersion from that response. If the data changed in the meantime the update is refused with version_conflict and the current version: read again and redo the change.
- Updates take a JSON Merge Patch: send only the fields that change; nested objects merge; lists replace (send the whole list); null clears a field.
- Deletes and bulk operations (revisions_restore): call with dryRun: true first, show the user the plan, then call again with confirm: true once they agree.
- notes_delete: call with dryRun: true first, show the user the plan, then call again with the same arguments plus previewToken and confirm: true.
- Tokens expire after 15 minutes and only work for the arguments that were previewed; preview again after any change.
- Never invent fields or values: unknown fields and options are rejected with the valid options.
- Every change saves a revision: revisions_list → revisions_restore to undo.
- A refused call returns an error that names the problem and how to fix it. Follow the message; never repeat a refused call unchanged.
```

Options: `intro`, `tools`, `readTool` (default `*_get`), `version` (a field name, or `false`), `confirm`, `preview`, `unknownFields`, `mergePatch`, `revisions` (`true` or `{ list, restore }`), `errors`, and `rules` for your own lines. Without `tools`, the flags alone decide which rules are written.

Error codes: `invalid_arguments`, `invalid_option`, `unknown_field`, `confirmation_required`, `preview_required`, `preview_invalid`, `preview_expired`, `preview_mismatch`, `preview_stale`, `version_required`, `version_conflict`, `not_found`, `internal_error`. Your handlers can throw `GuardrailError` with codes of their own.

## Limits

- **The in-memory stores are references.** `createMemoryStore` and `createMemoryRevisionStore` lose everything on restart and only work within one process. Implement `VersionedStore` and `RevisionStore` on your database for production.
- **Tokens are only as safe as the secret.** Use at least 32 random bytes, keep it out of the repository, and rotate it by passing `[newSecret, oldSecret]`. Anyone with the secret can mint tokens.
- **Tokens are not single-use.** A token can confirm the same call more than once until it expires. Make the action idempotent, or store `guard.preview.id` until `expiresAt` and refuse repeats.
- **Token claims are signed, not encrypted.** The action, resource and actor are readable by whoever holds the token; the arguments are only stored as a hash.
- **The actor binding is yours to get right.** `actor` must return an id the client can't choose, such as the user from verified auth info, with the tenant if you have one.
- **Version checks need an atomic write.** `checkVersion` alone only fails fast. The guarantee comes from your `compareAndSet` being atomic.
- **Snapshots are stored unredacted.** Redaction applies to what agents see; restore needs the real values. Encrypt secrets at rest in your `RevisionStore`.
- **Annotations are hints.** Clients may ignore `destructiveHint`. The guard is what actually refuses the call.
- **Output schemas and dry runs don't mix.** A tool with a dry run returns two shapes, so the SDK helpers refuse an `output` schema on it.

## License

MIT © Saimul Islam
