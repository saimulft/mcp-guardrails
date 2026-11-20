// Public API of mcp-guardrails. SDK-agnostic, no runtime dependencies; the official-SDK helpers live in
// `mcp-guardrails/sdk`.

/** Define tools: annotations from `kind`, plus dry-run, confirmation, preview-token and version guards. */
export { annotationsFor, defineTool } from './define.ts';
export type {
  ConfirmMode,
  ControlField,
  GuardContext,
  GuardedTool,
  PreviewResult,
  ToolAnnotations,
  ToolDefinition,
  ToolKind,
  VersionOptions,
} from './define.ts';

/** Signed, expiring preview tokens bound to an action, resource, actor and payload hash. */
export { DEFAULT_PREVIEW_TTL_MS, createPreviewTokens } from './tokens.ts';
export type {
  IssuedPreview,
  PreviewBinding,
  PreviewClaims,
  PreviewTokenOptions,
  PreviewTokens,
  Secret,
} from './tokens.ts';

/** Optimistic concurrency: version checks, compare-and-set writes and a reference in-memory store. */
export {
  checkVersion,
  createMemoryStore,
  deleteIfUnchanged,
  sameVersion,
  updateIfUnchanged,
  versionConflict,
} from './concurrency.ts';
export type {
  CheckVersionOptions,
  CompareAndSetResult,
  DeleteOptions,
  MemoryStore,
  RevisionTarget,
  UpdateOptions,
  Version,
  Versioned,
  VersionedStore,
  WriteResult,
} from './concurrency.ts';

/** Revision history: snapshot before each change, capped, redacted on output, with restore. */
export { DEFAULT_REDACTED_FIELDS, createMemoryRevisionStore, createRevisionLog } from './revisions.ts';
export type {
  RecordRevisionInput,
  RedactRule,
  RestoreOptions,
  RestoreResult,
  Revision,
  RevisionLog,
  RevisionLogOptions,
  RevisionOperation,
  RevisionQuery,
  RevisionStore,
  RevisionSummary,
} from './revisions.ts';

/** RFC 7396 JSON Merge Patch. */
export { jsonMergePatch } from './merge-patch.ts';

/** Agent-facing errors that name the valid options and the next step. */
export {
  GuardrailError,
  assertKnownFields,
  assertOption,
  closestMatch,
  confirmationRequired,
  invalidOption,
  isGuardrailError,
  notFound,
  unknownField,
} from './errors.ts';
export type { ErrorDetails, GuardrailErrorCode } from './errors.ts';

/** Tool results in the MCP shape. */
export { isToolResult, toolError, toolResult } from './result.ts';
export type { ErrorHandler, TextContent, ToolResult } from './result.ts';

/** The server-instructions text that teaches agents the conventions in use. */
export { instructions } from './instructions.ts';
export type { InstructionTool, InstructionsOptions } from './instructions.ts';
