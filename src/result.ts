import { isPlainObject } from './encoding.ts';
import { isGuardrailError } from './errors.ts';
import type { GuardrailError } from './errors.ts';

/** One text content block of a tool result. */
export interface TextContent {
  type: 'text';
  text: string;
}

/** A `tools/call` result in the MCP shape, accepted as is by the official SDKs. */
export interface ToolResult {
  [key: string]: unknown;
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Maps an unexpected error to one the agent may see, or returns nothing to report `internal_error`. */
export type ErrorHandler = (error: unknown, tool?: string) => GuardrailError | void;

const results = new WeakSet<object>();

/** True for a result made by `toolResult` or `toolError`, which tools pass through unchanged. */
export function isToolResult(value: unknown): value is ToolResult {
  return typeof value === 'object' && value !== null && results.has(value);
}

/**
 * The success result for `data`: its JSON as text plus the same object as `structuredContent`.
 * An object is sent as is, `undefined` as `{ ok: true }`, anything else as `{ result: data }`.
 */
export function toolResult(data: unknown): ToolResult {
  if (isToolResult(data)) return data;
  const structured: Record<string, unknown> =
    data === undefined ? { ok: true } : isPlainObject(data) ? data : { result: data };
  const result: ToolResult = {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
  results.add(result);
  return result;
}

const defaultHandler: ErrorHandler = (error, tool) => {
  console.error(`[mcp-guardrails] ${tool ? `tool ${tool}` : 'tool'} failed`, error);
};

/**
 * The `isError` result for `error`. A GuardrailError is shown to the agent as `{ error: { code, message,
 * ...details } }`; anything else goes to `onError` (default: console.error) and is reported as
 * `internal_error` without its message, so internals never leak.
 */
export function toolError(error: unknown, options: { tool?: string; onError?: ErrorHandler } = {}): ToolResult {
  let visible: GuardrailError | undefined = isGuardrailError(error) ? error : undefined;
  if (!visible) {
    const mapped = (options.onError ?? defaultHandler)(error, options.tool);
    visible = mapped && isGuardrailError(mapped) ? mapped : undefined;
  }
  const body = visible
    ? visible.toJSON()
    : { code: 'internal_error', message: 'Unexpected server error. Try again; if it repeats, report it.' };
  const structured = { error: body };
  const result: ToolResult = {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: true,
  };
  results.add(result);
  return result;
}
