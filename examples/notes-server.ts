// A small notes server with every guardrail on. Run it over stdio:
//   MCP_PREVIEW_SECRET=<32+ characters> node examples/notes-server.ts
// The README shows the same code, importing from the published package names.
import { pathToFileURL } from 'node:url';
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
} from '../src/index.ts';
import { defineTool, registerTools, revisionTools } from '../src/sdk.ts';
import type { ToolExtra } from '../src/sdk.ts';

type Note = { title: string; body: string; status: 'draft' | 'published' };
const NOTE_FIELDS = ['title', 'body', 'status'];
const STATUSES = ['draft', 'published'] as const;

export function createNotesServer(options: { secret: string; notes?: Record<string, Note> }) {
  const notes = createMemoryStore<Note>(options.notes);
  const revisions = createRevisionLog();
  const tokens = createPreviewTokens({ secret: options.secret });
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
    version: true,
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
    kind: 'destructive',
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
  return { server, notes, revisions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.MCP_PREVIEW_SECRET;
  if (!secret) throw new Error('Set MCP_PREVIEW_SECRET (at least 32 characters).');
  const { server } = createNotesServer({
    secret,
    notes: { n1: { title: 'Hello', body: 'First note', status: 'draft' } },
  });
  await server.connect(new StdioServerTransport());
}
