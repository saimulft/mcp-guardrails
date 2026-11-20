import type { Version } from './concurrency.ts';
import { isPlainObject } from './encoding.ts';
import { GuardrailError, assertKnownFields, confirmationRequired } from './errors.ts';
import { isToolResult, toolError, toolResult } from './result.ts';
import type { ErrorHandler, ToolResult } from './result.ts';
import type { PreviewBinding, PreviewClaims, PreviewTokens } from './tokens.ts';

/** `read` changes nothing, `write` changes data, `destructive` deletes or overwrites it. */
export type ToolKind = 'read' | 'write' | 'destructive';

/**
 * How a call is confirmed: `none`; `flag` needs `confirm: true` (with an optional `dryRun: true` plan
 * first); `preview` needs a dry run first and then `confirm: true` with its signed `previewToken`.
 */
export type ConfirmMode = 'none' | 'flag' | 'preview';

/** MCP tool annotations (hints for clients). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Version-check options of a tool. */
export interface VersionOptions {
  /** The argument the agent sends. Default `expectedVersion` (use `expectedUpdatedAt` for timestamps). */
  field?: string;
  /** Refuse calls without it. Default true. */
  required?: boolean;
}

/** What the guard tells `run` and `plan` about the call. */
export interface GuardContext {
  /** The tool name. */
  tool: string;
  /** The version the agent sent, whatever the argument is called. */
  expectedVersion?: Version;
  /** True when the call was confirmed (always false in `none` mode). */
  confirmed: boolean;
  /** The verified preview token, in `preview` mode. */
  preview?: PreviewClaims;
}

/** Everything `defineTool` takes. `Args` are the tool's own arguments; `Ctx` is whatever your server passes per call. */
export interface ToolDefinition<Args = Record<string, unknown>, Ctx = unknown> {
  name: string;
  kind: ToolKind;
  description: string;
  title?: string;
  /** Calling it twice with the same arguments has no extra effect. Default false. */
  idempotent?: boolean;
  /** Reaches outside your own system (the web, other people's accounts). Default false. */
  openWorld?: boolean;
  /** Default: `preview` for destructive tools with `tokens`, `flag` for other destructive tools, else `none`. */
  confirm?: ConfirmMode;
  /** Signs preview tokens. Required in `preview` mode. */
  tokens?: PreviewTokens;
  /**
   * In `preview` mode: a separate tool that issues the token (it calls `tool.preview`). This tool then
   * takes no `dryRun`, and errors point the agent to the preview tool.
   */
  previewTool?: string;
  /** Adds an expected-version argument. `true` means `{ field: 'expectedVersion', required: true }`. */
  version?: boolean | VersionOptions;
  /** The resource a preview token is bound to. Default: the `id` argument, or "" when there is none. */
  resource?: (args: Args) => string;
  /** Who is calling. Required in `preview` mode; include the tenant when there is one. */
  actor?: (ctx: Ctx) => string | Promise<string>;
  /** What the token binds as payload. Default: every argument except `dryRun`, `confirm` and `previewToken`. */
  bind?: (args: Args) => unknown;
  /** State the plan depends on (a count, a version); a change between preview and confirm gives `preview_stale`. */
  fingerprint?: (args: Args, ctx: Ctx) => unknown;
  /** Known argument names. When set, any other argument is refused with `unknown_field` listing these. */
  fields?: readonly string[];
  /** The dry-run result. Default: the tool, resource and arguments. Must not change anything. */
  plan?: (args: Args, ctx: Ctx, guard: GuardContext) => unknown;
  /** Does the work. Return plain data (sent as JSON and `structuredContent`) or a `toolResult(...)`. */
  run: (args: Args, ctx: Ctx, guard: GuardContext) => unknown;
  /** Maps unexpected errors to agent-facing ones. Default: log with console.error, report `internal_error`. */
  onError?: ErrorHandler;
}

/** An argument the guard adds to a tool's input. */
export interface ControlField {
  name: string;
  type: 'boolean' | 'string' | 'version';
  required: boolean;
  description: string;
}

/** The result of `tool.preview`. */
export interface PreviewResult {
  plan: unknown;
  previewToken: string;
  expiresAt: string;
}

/** A tool with its annotations and guard, ready to register on any MCP server. */
export interface GuardedTool<Args = Record<string, unknown>, Ctx = unknown> {
  readonly name: string;
  readonly kind: ToolKind;
  readonly title?: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly confirm: ConfirmMode;
  readonly previewTool?: string;
  /** Lifetime of preview tokens in milliseconds, in `preview` mode. */
  readonly previewTtlMs?: number;
  readonly version?: Required<VersionOptions>;
  /** Arguments the guard adds (`dryRun`, `confirm`, `previewToken`, the version field). */
  readonly controlFields: readonly ControlField[];
  /** Runs the guard and the tool. Never throws: failures come back as `isError` results. */
  call(args: unknown, ctx: Ctx): Promise<ToolResult>;
  /** Computes the plan and signs a preview token for these arguments (for a separate preview tool). */
  preview(args: Args, ctx: Ctx): Promise<PreviewResult>;
}

const CONTROL = ['dryRun', 'confirm', 'previewToken'] as const;

/** MCP annotations for a tool kind. */
export function annotationsFor(
  kind: ToolKind,
  options: { title?: string; idempotent?: boolean; openWorld?: boolean } = {},
): ToolAnnotations {
  const base: ToolAnnotations = options.title ? { title: options.title } : {};
  if (kind === 'read') return { ...base, readOnlyHint: true, openWorldHint: options.openWorld ?? false };
  return {
    ...base,
    readOnlyHint: false,
    destructiveHint: kind === 'destructive',
    idempotentHint: options.idempotent ?? false,
    openWorldHint: options.openWorld ?? false,
  };
}

function minutes(ms: number): string {
  const value = Math.round(ms / 60000);
  return value >= 1 ? `${value} minute${value === 1 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`;
}

/**
 * Defines a tool from one description: the MCP annotations follow from `kind`, and the guard adds and
 * enforces the dry-run, confirmation, preview-token and version arguments the tool asks for.
 */
export function defineTool<Args = Record<string, unknown>, Ctx = unknown>(
  definition: ToolDefinition<Args, Ctx>,
): GuardedTool<Args, Ctx> {
  const { name, kind } = definition;
  if (!name || typeof name !== 'string') throw new TypeError('defineTool: name is required');
  if (kind !== 'read' && kind !== 'write' && kind !== 'destructive') {
    throw new TypeError(`defineTool(${name}): kind must be "read", "write" or "destructive"`);
  }
  const confirm: ConfirmMode =
    definition.confirm ?? (kind === 'destructive' ? (definition.tokens ? 'preview' : 'flag') : 'none');
  if (kind === 'read' && (confirm !== 'none' || definition.version)) {
    throw new TypeError(`defineTool(${name}): read tools take no confirmation or version check`);
  }
  if (confirm === 'preview' && !definition.tokens) {
    throw new TypeError(`defineTool(${name}): confirm "preview" needs tokens (createPreviewTokens)`);
  }
  if (confirm === 'preview' && !definition.actor) {
    throw new TypeError(
      `defineTool(${name}): confirm "preview" needs actor(ctx), the caller's id, so a token can't be used by someone else`,
    );
  }
  if (definition.previewTool && confirm !== 'preview') {
    throw new TypeError(`defineTool(${name}): previewTool only applies to confirm "preview"`);
  }

  const version: Required<VersionOptions> | undefined = definition.version
    ? {
        field: (definition.version === true ? undefined : definition.version.field) ?? 'expectedVersion',
        required: (definition.version === true ? undefined : definition.version.required) ?? true,
      }
    : undefined;
  const tokens = definition.tokens;
  const previewTool = definition.previewTool;
  const ttl = tokens ? minutes(tokens.ttlMs) : '';

  const controlFields: ControlField[] = [];
  if ((confirm === 'flag' || confirm === 'preview') && !previewTool) {
    controlFields.push({
      name: 'dryRun',
      type: 'boolean',
      required: false,
      description:
        confirm === 'preview'
          ? 'Preview only: returns the plan and a previewToken and changes nothing. Do this first.'
          : 'Preview only: returns the plan and changes nothing.',
    });
  }
  if (confirm !== 'none') {
    controlFields.push({
      name: 'confirm',
      type: 'boolean',
      required: false,
      description: 'Must be true to apply the change, and only after the user agreed to it.',
    });
  }
  if (confirm === 'preview') {
    controlFields.push({
      name: 'previewToken',
      type: 'string',
      required: false,
      description: `Token from ${previewTool ?? 'the dryRun call'}. Valid for ${ttl}, for exactly the previewed arguments.`,
    });
  }
  if (version) {
    controlFields.push({
      name: version.field,
      type: 'version',
      required: version.required,
      description: `The version from your latest read of this resource. A change made in the meantime is refused with version_conflict.`,
    });
  }

  const controlNames = controlFields.map((field) => field.name);
  const knownFields = definition.fields ? [...new Set([...definition.fields, ...controlNames])] : undefined;
  const resourceOf = (args: Args): string => {
    if (definition.resource) return definition.resource(args);
    const id = (args as { id?: unknown } | undefined)?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  };
  const payloadOf = (args: Args): unknown => {
    if (definition.bind) return definition.bind(args);
    const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    for (const key of CONTROL) delete copy[key];
    return copy;
  };
  const planOf = async (args: Args, ctx: Ctx, guard: GuardContext) =>
    definition.plan
      ? definition.plan(args, ctx, guard)
      : { tool: name, ...(resourceOf(args) ? { resource: resourceOf(args) } : {}), arguments: payloadOf(args) };
  const bindingOf = async (args: Args, ctx: Ctx): Promise<PreviewBinding> => ({
    action: name,
    resource: resourceOf(args),
    actor: await definition.actor!(ctx),
    payload: payloadOf(args),
    ...(definition.fingerprint ? { state: await definition.fingerprint(args, ctx) } : {}),
  });

  const preview = async (args: Args, ctx: Ctx, guard?: GuardContext): Promise<PreviewResult> => {
    if (!tokens || !definition.actor) throw new TypeError(`${name} has no preview tokens`);
    const plan = await planOf(args, ctx, guard ?? { tool: name, confirmed: false });
    const issued = await tokens.issue(await bindingOf(args, ctx));
    return { plan, previewToken: issued.token, expiresAt: issued.expiresAt };
  };

  const how = previewTool
    ? `Call ${previewTool} first, show the user the plan, then call ${name} with its previewToken and confirm: true.`
    : `Call ${name} with dryRun: true first, show the user the plan, then call it again with the same arguments plus previewToken and confirm: true.`;

  const call = async (raw: unknown, ctx: Ctx): Promise<ToolResult> => {
    try {
      if (raw !== undefined && !isPlainObject(raw)) {
        throw new GuardrailError('invalid_arguments', `${name} takes an object of named arguments.`);
      }
      const input = (raw ?? {}) as Record<string, unknown>;
      if (knownFields) assertKnownFields(input, knownFields);
      for (const key of ['dryRun', 'confirm'] as const) {
        if (controlNames.includes(key) && input[key] !== undefined && typeof input[key] !== 'boolean') {
          throw new GuardrailError('invalid_arguments', `${key} must be true or false.`, { field: key });
        }
      }

      const guard: GuardContext = { tool: name, confirmed: false };
      if (version) {
        const value = input[version.field];
        if (value === undefined || value === null || value === '') {
          if (version.required) {
            throw new GuardrailError(
              'version_required',
              `${version.field} is required: read the resource first and pass the version from that response.`,
              { field: version.field },
            );
          }
        } else if (typeof value === 'string' || typeof value === 'number') {
          guard.expectedVersion = value;
        } else {
          throw new GuardrailError('invalid_arguments', `${version.field} must be a string or a number.`, {
            field: version.field,
          });
        }
      }

      const args = input as Args;
      const dryRun = controlNames.includes('dryRun') && input.dryRun === true;

      if (confirm === 'flag') {
        if (dryRun) {
          return toolResult({
            dryRun: true,
            plan: await planOf(args, ctx, guard),
            next: `Show the user this plan. To apply it, call ${name} again with the same arguments and confirm: true.`,
          });
        }
        if (input.confirm !== true) {
          throw confirmationRequired(
            name,
            `${name} needs confirm: true. Call it with dryRun: true to see the plan, ask the user, then call it again with confirm: true.`,
          );
        }
        guard.confirmed = true;
      }

      if (confirm === 'preview') {
        if (dryRun) {
          const result = await preview(args, ctx, guard);
          return toolResult({
            dryRun: true,
            ...result,
            next: `Show the user this plan. To apply it, call ${name} again with the same arguments plus this previewToken and confirm: true (valid until ${result.expiresAt}).`,
          });
        }
        if (input.confirm !== true) throw confirmationRequired(name, `${name} needs confirm: true. ${how}`);
        const token = input.previewToken;
        if (typeof token !== 'string' || !token) {
          throw new GuardrailError('preview_required', `${name} needs a previewToken. ${how}`, {
            tool: name,
            ...(previewTool ? { previewTool } : {}),
          });
        }
        guard.preview = await tokens!.verify(token, await bindingOf(args, ctx));
        guard.confirmed = true;
      }

      const data = await definition.run(args, ctx, guard);
      return isToolResult(data) ? data : toolResult(data);
    } catch (error) {
      return toolError(error, { tool: name, onError: definition.onError });
    }
  };

  return {
    name,
    kind,
    description: definition.description,
    ...(definition.title ? { title: definition.title } : {}),
    annotations: annotationsFor(kind, definition),
    confirm,
    ...(previewTool ? { previewTool } : {}),
    ...(tokens && confirm === 'preview' ? { previewTtlMs: tokens.ttlMs } : {}),
    ...(version ? { version } : {}),
    controlFields,
    call,
    preview: (args, ctx) => preview(args, ctx),
  };
}
