// Integration with the official TypeScript SDK (`@modelcontextprotocol/sdk` 1.x) and zod 4.
// Imported as `mcp-guardrails/sdk`; the core (`mcp-guardrails`) never loads it.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { VersionedStore } from './concurrency.ts';
import { defineTool as defineCoreTool } from './define.ts';
import type { GuardedTool, ToolAnnotations, ToolDefinition } from './define.ts';
import { invalidOption, unknownField } from './errors.ts';
import type { RevisionLog } from './revisions.ts';
import type { PreviewTokens } from './tokens.ts';

/** The per-call context the SDK passes to tool handlers (auth info, session id, abort signal). */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** A zod 4 object shape: `{ id: z.string(), ... }`. */
export type Shape = z.ZodRawShape;

/** The arguments a handler receives for an input shape. */
export type ShapeArgs<S extends Shape> = z.output<z.ZodObject<S>>;

/** `defineTool` options plus the zod input (and optional output) of the tool. */
export interface SdkToolDefinition<S extends Shape = Shape> extends Omit<
  ToolDefinition<ShapeArgs<S>, ToolExtra>,
  'fields'
> {
  /** The tool's own arguments. The guard's arguments are added to it. */
  input?: S;
  /** Output schema. Not allowed on tools with a dry run, whose results have a different shape. */
  output?: Shape | z.ZodObject;
}

/** The config object `McpServer.registerTool` takes. */
export interface SdkToolConfig {
  title?: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema?: z.ZodObject;
  annotations: ToolAnnotations;
}

/**
 * The full input schema: the tool's shape plus the guard's arguments, as a strict object. An unknown
 * argument is refused with a message that lists the known ones.
 */
export function inputSchema(tool: GuardedTool<never, never>, input: Shape = {}): z.ZodObject {
  const shape: Record<string, z.core.$ZodType> = { ...input };
  for (const field of tool.controlFields) {
    let schema: z.ZodType;
    if (field.type === 'boolean') schema = z.boolean();
    else if (field.type === 'string') schema = z.string();
    else {
      schema = z.union([z.string(), z.number()], {
        error: (issue) =>
          issue.input === undefined
            ? `${field.name} is required: read the resource first and pass the version from that response`
            : undefined,
      });
    }
    schema = schema.describe(field.description);
    shape[field.name] = field.required ? schema : schema.optional();
  }
  const known = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) => (issue.code === 'unrecognized_keys' ? unknownField(issue.keys, known).message : undefined),
  });
}

/** The `registerTool` config for a guarded tool: description, annotations and the extended input schema. */
export function toolConfig(
  tool: GuardedTool<never, never>,
  schemas: { input?: Shape; output?: Shape | z.ZodObject } = {},
): SdkToolConfig {
  if (schemas.output && tool.controlFields.some((field) => field.name === 'dryRun')) {
    throw new TypeError(`${tool.name}: an output schema can't describe dry-run results; leave output out`);
  }
  const output = schemas.output
    ? schemas.output instanceof z.ZodObject
      ? schemas.output
      : z.object(schemas.output)
    : undefined;
  return {
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: inputSchema(tool, schemas.input),
    ...(output ? { outputSchema: output } : {}),
    annotations: tool.annotations,
  };
}

/**
 * The `registerTool` callback for a guarded tool. With `output` set, error results leave out
 * `structuredContent`, which the SDK client would otherwise check against the output schema.
 */
export function toolHandler<Args>(
  tool: GuardedTool<Args, ToolExtra>,
  options: { output?: boolean } = {},
): (args: Record<string, unknown>, extra: ToolExtra) => Promise<CallToolResult> {
  return async (args, extra) => {
    const result = await tool.call(args, extra);
    if (options.output && result.isError) {
      const copy = { ...result };
      delete copy.structuredContent;
      return copy;
    }
    return result;
  };
}

/** A guarded tool that also carries its zod input (and output) schema, made by `defineTool` from this module. */
export type SdkTool<Args = Record<string, unknown>> = GuardedTool<Args, ToolExtra> & {
  readonly input: Shape;
  readonly output?: z.ZodObject;
};

/**
 * `defineTool` for the official SDK: the same options plus a zod `input` shape, which types the
 * handler's arguments. Register the result with `registerTools`.
 */
export function defineTool<S extends Shape = Record<never, never>>(
  definition: SdkToolDefinition<S>,
): SdkTool<ShapeArgs<S>> {
  const { input, output, ...rest } = definition;
  const shape: Shape = input ?? {};
  const tool = defineCoreTool<ShapeArgs<S>, ToolExtra>(rest);
  const outputSchema = output ? (output instanceof z.ZodObject ? output : z.object(output)) : undefined;
  if (outputSchema && tool.controlFields.some((field) => field.name === 'dryRun')) {
    throw new TypeError(`defineTool(${tool.name}): an output schema can't describe dry-run results; leave output out`);
  }
  return { ...tool, input: shape, ...(outputSchema ? { output: outputSchema } : {}) };
}

/** Registers tools made by this module's `defineTool` (or `revisionTools`) on an `McpServer`. */
export function registerTools(server: McpServer, tools: readonly SdkTool<never>[]): void {
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || !('input' in tool)) {
      throw new TypeError(
        "registerTools: define tools with defineTool from 'mcp-guardrails/sdk', which carries the input schema",
      );
    }
    const config = toolConfig(tool, { input: tool.input, output: tool.output });
    server.registerTool(tool.name, config, toolHandler(tool, { output: Boolean(tool.output) }));
  }
}

/** Options for `revisionTools`. */
export interface RevisionToolsOptions {
  log: RevisionLog;
  /** The store of each resource type the log holds revisions for, for example `{ note: notes }`. */
  stores: Record<string, VersionedStore<unknown>>;
  /** The caller's partition (tenant). Lists and restores only see revisions of that scope. */
  scope?: (extra: ToolExtra) => string | undefined;
  /** The caller's id, saved on restore revisions. Required with `tokens`. */
  actor?: (extra: ToolExtra) => string;
  /** Use preview tokens for restores. Default: `dryRun` then `confirm: true`. */
  tokens?: PreviewTokens;
  /** Tool names. Default `revisions_list` and `revisions_restore`. */
  names?: { list?: string; restore?: string };
}

/** Arguments of the revisions list tool. */
export interface RevisionListArgs {
  resourceType?: string;
  resourceId?: string;
  limit?: number;
}

/** `revisions_list` (read) and `revisions_restore` (destructive, confirmed) for a revision log, ready for `registerTools`. */
export function revisionTools(options: RevisionToolsOptions): {
  list: SdkTool<RevisionListArgs>;
  restore: SdkTool<{ revisionId: string }>;
} {
  const types = Object.keys(options.stores);
  if (types.length === 0) throw new TypeError('revisionTools: pass at least one store');
  const listName = options.names?.list ?? 'revisions_list';
  const restoreName = options.names?.restore ?? 'revisions_restore';
  const { log } = options;
  const scopeOf = (extra: ToolExtra) => options.scope?.(extra);
  const storeFor = (type: string) => {
    const store = options.stores[type];
    if (!store) throw invalidOption('resourceType', type, types);
    return store;
  };

  const list = defineTool({
    name: listName,
    kind: 'read',
    description: `List saved revisions, newest first. Every change saves the previous state; pass a revision id to ${restoreName} to undo it.`,
    input: {
      resourceType: z
        .enum(types as [string, ...string[]])
        .optional()
        .describe('Only this resource type.'),
      resourceId: z.string().min(1).optional().describe('Only this resource.'),
      limit: z.number().int().min(1).optional().describe('Page size. Default 20, at most 100.'),
    },
    async run(args, extra) {
      const scope = scopeOf(extra);
      return { revisions: await log.list({ ...args, ...(scope === undefined ? {} : { scope }) }) };
    },
  });

  const restore = defineTool({
    name: restoreName,
    kind: 'destructive',
    description: `Undo a change: put a resource back to the state saved in a revision (${listName} lists them). The state it replaces is saved as a new revision, so a restore can be undone too.`,
    input: { revisionId: z.string().min(1).describe(`Revision id from ${listName}.`) },
    ...(options.tokens ? { tokens: options.tokens, actor: options.actor } : {}),
    resource: (args) => args.revisionId,
    async plan(args, extra) {
      const revision = await log.get(args.revisionId, { scope: scopeOf(extra) });
      const current = await storeFor(revision.resourceType).get(revision.resourceId);
      const { snapshot, ...summary } = revision;
      return { revision: summary, restores: snapshot, replaces: current ? log.redact(current.value) : null };
    },
    async run(args, extra) {
      const scope = scopeOf(extra);
      const revision = await log.get(args.revisionId, { scope });
      return log.restore(args.revisionId, {
        store: storeFor(revision.resourceType),
        ...(scope === undefined ? {} : { scope }),
        ...(options.actor ? { actor: options.actor(extra) } : {}),
      });
    },
  });

  return { list, restore };
}
