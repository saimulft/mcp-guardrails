import { GuardrailError, notFound } from './errors.ts';
import type { RevisionLog } from './revisions.ts';

/** A resource version: a counter, an etag, or an `updatedAt` timestamp as an ISO string. */
export type Version = string | number;

/** A stored value with its version. */
export interface Versioned<T> {
  value: T;
  version: Version;
}

/** Outcome of a compare-and-set: the new version (`null` after a delete), or `ok: false` when it moved on. */
export type CompareAndSetResult = { ok: true; version: Version | null } | { ok: false };

/**
 * The one storage interface for versioned writes. `compareAndSet` must be atomic: write `next` only while
 * the stored version still equals `expected`, and bump the version in the same write.
 * `null` means "absent" on both sides: `expected: null` creates, `next: null` deletes.
 */
export interface VersionedStore<T> {
  get(id: string): Promise<Versioned<T> | undefined>;
  compareAndSet(id: string, expected: Version | null, next: T | null): Promise<CompareAndSetResult>;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function normalize(version: Version): Version {
  if (typeof version === 'string') {
    const text = version.trim();
    if (TIMESTAMP.test(text)) {
      const time = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
      if (!Number.isNaN(time)) return new Date(time).toISOString();
    }
    return text;
  }
  return version;
}

/**
 * True when two versions are the same. Timestamps compare by instant, so `2025-01-02T03:04:05Z` equals
 * `2025-01-02T03:04:05.000Z`; numbers and their decimal strings are equal too.
 */
export function sameVersion(a: Version | null | undefined, b: Version | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a == b;
  return String(normalize(a)) === String(normalize(b));
}

/** Options for `checkVersion`. */
export interface CheckVersionOptions {
  /** Refuse a missing expected version with `version_required`. Default true. */
  required?: boolean;
  /** The argument name the agent sends, for messages. Default `expectedVersion`. */
  field?: string;
  /** What is being changed, for messages, for example `note "n1"`. */
  resource?: string;
}

/** `version_conflict`: the resource moved on. Carries the current version so the agent can re-read. */
export function versionConflict(
  currentVersion: Version | null,
  expectedVersion: unknown,
  resource?: string,
): GuardrailError {
  const what = resource ?? 'The resource';
  return new GuardrailError(
    'version_conflict',
    `${what} was changed since you read it (current version ${JSON.stringify(currentVersion)}, you sent ${JSON.stringify(expectedVersion)}). ` +
      'Read it again, redo your change on the current data, and pass the new version.',
    { currentVersion, expectedVersion, ...(resource ? { resource } : {}) },
  );
}

/**
 * Fast-fail check of `expected` against the version just read. Throws `version_required` or
 * `version_conflict`. Not a lock on its own: pair it with `compareAndSet` (or `updateIfUnchanged`).
 */
export function checkVersion(
  current: Version | null | undefined,
  expected: unknown,
  options: CheckVersionOptions = {},
): void {
  const field = options.field ?? 'expectedVersion';
  if (expected === undefined || expected === null || expected === '') {
    if (options.required ?? true) {
      throw new GuardrailError(
        'version_required',
        `${field} is required: pass the version from your latest read so a change made in the meantime is not overwritten.`,
        { field },
      );
    }
    return;
  }
  if (typeof expected !== 'string' && typeof expected !== 'number') {
    throw new GuardrailError(
      'invalid_arguments',
      `${field} must be a string or a number, the version from your latest read.`,
      {
        field,
      },
    );
  }
  if (!sameVersion(current, expected)) throw versionConflict(current ?? null, expected, options.resource);
}

/** Records a revision of the previous value after a successful write. */
export interface RevisionTarget {
  log: RevisionLog;
  /** The resource type the revision is filed under, for example `note`. */
  resourceType: string;
  actor?: string;
  /** Partition, for example the tenant id. Lists and restores only see revisions of their own scope. */
  scope?: string;
  summary?: string;
}

/** Options for `updateIfUnchanged`. */
export interface UpdateOptions<T> {
  id: string;
  /** The version the agent read. */
  expectedVersion: unknown;
  /** Computes the new value from the current one. Must not have side effects: it may run before a conflict. */
  update: (current: T) => T | Promise<T>;
  /** Refuse calls without `expectedVersion`. Default true. */
  required?: boolean;
  /** Names the resource in messages. Default `` `${resourceType ?? 'resource'} "${id}"` ``. */
  label?: string;
  /** Snapshot the previous value into this revision log once the write succeeds. */
  revision?: RevisionTarget;
}

/** Options for `deleteIfUnchanged`. */
export type DeleteOptions<T> = Omit<UpdateOptions<T>, 'update'>;

/** What a versioned write returns. */
export interface WriteResult<T> {
  /** The stored value after the write; `null` after a delete. */
  value: T | null;
  /** The new version; `null` after a delete. */
  version: Version | null;
  /** The value before the write. */
  previous: T;
  previousVersion: Version;
  /** Id of the revision saved for the previous value, when `revision` was set. */
  revisionId?: string;
}

async function writeIfUnchanged<T>(
  store: VersionedStore<T>,
  options: DeleteOptions<T> & { update?: (current: T) => T | Promise<T> },
): Promise<WriteResult<T>> {
  const label = options.label ?? `${options.revision?.resourceType ?? 'resource'} ${JSON.stringify(options.id)}`;
  const current = await store.get(options.id);
  if (!current) throw notFound(options.revision?.resourceType ?? 'resource', options.id);
  checkVersion(current.version, options.expectedVersion, { required: options.required, resource: label });

  const next = options.update ? await options.update(current.value) : null;
  const result = await store.compareAndSet(options.id, current.version, next);
  if (!result.ok) {
    const latest = await store.get(options.id);
    if (!latest) throw notFound(options.revision?.resourceType ?? 'resource', options.id);
    throw versionConflict(latest.version, options.expectedVersion ?? current.version, label);
  }

  let revisionId: string | undefined;
  if (options.revision) {
    const { log, ...target } = options.revision;
    const saved = await log.record({
      ...target,
      resourceId: options.id,
      operation: next === null ? 'delete' : 'update',
      snapshot: current.value,
      version: current.version,
    });
    revisionId = saved.id;
  }
  return {
    value: next,
    version: result.version,
    previous: current.value,
    previousVersion: current.version,
    revisionId,
  };
}

/**
 * Optimistic-locked update: reads the current value, checks `expectedVersion`, and writes the update with
 * an atomic compare-and-set. When another writer got in between, nothing is written and the call fails
 * with `version_conflict` carrying the current version.
 */
export function updateIfUnchanged<T>(store: VersionedStore<T>, options: UpdateOptions<T>): Promise<WriteResult<T>> {
  return writeIfUnchanged(store, options);
}

/** Optimistic-locked delete, with the same checks as `updateIfUnchanged`. */
export function deleteIfUnchanged<T>(store: VersionedStore<T>, options: DeleteOptions<T>): Promise<WriteResult<T>> {
  return writeIfUnchanged(store, { ...options, update: undefined });
}

/** An in-memory `VersionedStore` with a `seed` method and a synchronous `snapshot` for tests. */
export interface MemoryStore<T> extends VersionedStore<T> {
  /** Writes without a version check (setup and tests). Returns the new version. */
  seed(id: string, value: T): number;
  /** All current values by id. */
  snapshot(): Record<string, Versioned<T>>;
}

/**
 * A reference `VersionedStore` kept in memory. Versions are integers from one counter shared by every
 * id, so a deleted and recreated record never reuses an old version. Values are cloned in and out.
 */
export function createMemoryStore<T>(initial: Record<string, T> = {}): MemoryStore<T> {
  const rows = new Map<string, { value: T; version: number }>();
  let counter = 0;
  const store: MemoryStore<T> = {
    async get(id) {
      const row = rows.get(id);
      return row ? { value: structuredClone(row.value), version: row.version } : undefined;
    },
    async compareAndSet(id, expected, next) {
      const row = rows.get(id);
      const matches = row ? expected !== null && sameVersion(row.version, expected) : expected === null;
      if (!matches) return { ok: false };
      if (next === null) {
        rows.delete(id);
        return { ok: true, version: null };
      }
      const version = ++counter;
      rows.set(id, { value: structuredClone(next), version });
      return { ok: true, version };
    },
    seed(id, value) {
      const version = ++counter;
      rows.set(id, { value: structuredClone(value), version });
      return version;
    },
    snapshot() {
      const out: Record<string, Versioned<T>> = {};
      for (const [id, row] of rows) out[id] = { value: structuredClone(row.value), version: row.version };
      return out;
    },
  };
  for (const [id, value] of Object.entries(initial)) store.seed(id, value);
  return store;
}
