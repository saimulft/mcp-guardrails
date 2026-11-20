/** Error codes this package produces. Your own handlers may throw GuardrailError with any other code. */
export type GuardrailErrorCode =
  | 'invalid_arguments'
  | 'invalid_option'
  | 'unknown_field'
  | 'confirmation_required'
  | 'preview_required'
  | 'preview_invalid'
  | 'preview_expired'
  | 'preview_mismatch'
  | 'preview_stale'
  | 'version_required'
  | 'version_conflict'
  | 'not_found'
  | 'internal_error';

/** Extra machine-readable fields an error carries next to its code and message. */
export type ErrorDetails = Record<string, unknown>;

/**
 * An error written for the agent: a stable `code`, a message that says what to do next, and details
 * such as the valid options. Tools turn it into an `isError` result instead of a protocol error.
 */
export class GuardrailError extends Error {
  readonly code: GuardrailErrorCode | (string & {});
  readonly details: ErrorDetails;

  constructor(code: GuardrailErrorCode | (string & {}), message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'GuardrailError';
    this.code = code;
    this.details = details;
  }

  /** The shape agents see: `{ code, message, ...details }`. */
  toJSON(): ErrorDetails & { code: string; message: string } {
    return { ...this.details, code: this.code, message: this.message };
  }
}

/** True for a GuardrailError, also one created by another copy of this package. */
export function isGuardrailError(error: unknown): error is GuardrailError {
  return (
    error instanceof GuardrailError ||
    (error instanceof Error &&
      error.name === 'GuardrailError' &&
      typeof (error as { code?: unknown }).code === 'string' &&
      typeof (error as { details?: unknown }).details === 'object')
  );
}

const list = (values: readonly unknown[]) => values.map((v) => JSON.stringify(v)).join(', ');

/** The closest candidate to `input` by edit distance, when it is close enough to be a likely typo. */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const limit = Math.max(2, Math.floor(input.length / 3));
  return best !== undefined && bestDistance <= limit ? best : undefined;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** `invalid_option`: `value` is not one of `options`. The error lists them, with a "did you mean" when close. */
export function invalidOption(field: string, value: unknown, options: readonly (string | number)[]): GuardrailError {
  const suggestion = typeof value === 'string' ? closestMatch(value, options.map(String)) : undefined;
  const valid = options.length ? `Valid options: ${list(options)}.` : 'There are no valid options yet.';
  return new GuardrailError(
    'invalid_option',
    `${JSON.stringify(value)} is not a valid ${field}. ${valid}${suggestion ? ` Did you mean ${JSON.stringify(suggestion)}?` : ''}`,
    { field, value, validOptions: [...options], ...(suggestion ? { didYouMean: suggestion } : {}) },
  );
}

/** `unknown_field`: the named fields don't exist. The error lists the known ones. */
export function unknownField(
  fields: readonly string[],
  knownFields: readonly string[],
  where?: string,
): GuardrailError {
  const suggestions: Record<string, string> = {};
  for (const field of fields) {
    const match = closestMatch(field, knownFields);
    if (match) suggestions[field] = match;
  }
  const hints = Object.entries(suggestions).map(([from, to]) => `${JSON.stringify(from)} → ${JSON.stringify(to)}`);
  const plural = fields.length === 1 ? 'field' : 'fields';
  return new GuardrailError(
    'unknown_field',
    `Unknown ${plural}${where ? ` in ${where}` : ''}: ${list(fields)}. Known fields: ${list(knownFields) || 'none'}.` +
      (hints.length ? ` Did you mean ${hints.join(', ')}?` : '') +
      ' Never invent fields.',
    {
      fields: [...fields],
      knownFields: [...knownFields],
      ...(where ? { where } : {}),
      ...(hints.length ? { didYouMean: suggestions } : {}),
    },
  );
}

/** `confirmation_required`: the call needs `confirm: true` after the user agreed. `next` says how to get there. */
export function confirmationRequired(tool: string, next?: string): GuardrailError {
  return new GuardrailError(
    'confirmation_required',
    next ?? `${tool} needs confirm: true. Ask the user first, then call it again with confirm: true.`,
    { tool },
  );
}

/** `not_found`: no `resource` with this id. */
export function notFound(resource: string, id: string): GuardrailError {
  return new GuardrailError('not_found', `No ${resource} ${JSON.stringify(id)}.`, { resource, id });
}

/** Returns `value` when it is one of `options`, otherwise throws `invalid_option` listing them. */
export function assertOption<const T extends string | number>(field: string, value: unknown, options: readonly T[]): T {
  if (!(options as readonly unknown[]).includes(value)) throw invalidOption(field, value, options);
  return value as T;
}

/** Throws `unknown_field` when `value` (an object) has keys outside `knownFields`. */
export function assertKnownFields(value: unknown, knownFields: readonly string[], where?: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const known = new Set(knownFields);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length) throw unknownField(unknown, knownFields, where);
}
