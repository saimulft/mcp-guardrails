import { versionConflict } from './concurrency.ts';
import type { Version, VersionedStore } from './concurrency.ts';
import { GuardrailError } from './errors.ts';

/** What a revision records. */
export type RevisionOperation = 'create' | 'update' | 'delete' | 'restore';

/** A snapshot of a resource taken before a change. */
export interface Revision<T = unknown> {
  id: string;
  resourceType: string;
  resourceId: string;
  /** Partition, for example the tenant id. */
  scope?: string;
  operation: RevisionOperation;
  /** The value before the change; `null` when the resource did not exist yet. */
  snapshot: T | null;
  /** The version of `snapshot`. */
  version?: Version | null;
  actor?: string;
  summary?: string;
  /** ISO timestamp. */
  createdAt: string;
}

/** A revision without its snapshot, as lists return it. */
export type RevisionSummary = Omit<Revision, 'snapshot'>;

/** Filters for listing revisions. */
export interface RevisionQuery {
  resourceType?: string;
  resourceId?: string;
  scope?: string;
  limit?: number;
}

/**
 * Where revisions live. Implement it on your database; `createMemoryRevisionStore` is the reference.
 * Snapshots are stored unredacted (restore needs them), so encrypt them at rest here if they hold secrets.
 */
export interface RevisionStore {
  add(revision: Revision): Promise<void>;
  get(id: string): Promise<Revision | undefined>;
  /** Matching revisions, newest first, at most `limit`. A missing `scope` in the query matches every scope. */
  list(query: RevisionQuery & { limit: number }): Promise<Revision[]>;
  /** Deletes all but the newest `keep` revisions of one resource. */
  prune(resource: { resourceType: string; resourceId: string; scope?: string }, keep: number): Promise<void>;
}

/** A field name to redact (exact match) or a pattern of names. */
export type RedactRule = string | RegExp;

/** Options for `createRevisionLog`. */
export interface RevisionLogOptions {
  /** Default: an in-memory store. */
  store?: RevisionStore;
  /** History kept per resource; older revisions are pruned. Default 30. */
  maxPerResource?: number;
  /** Fields whose values are replaced by `"[redacted]"` in `get` and in restore plans. Default `DEFAULT_REDACTED_FIELDS`. */
  redact?: readonly RedactRule[];
  /** Page size of `list` when none is asked for. Default 20. */
  defaultListLimit?: number;
  /** Largest page `list` returns. Default 100. */
  maxListLimit?: number;
  /** Clock in milliseconds. Default `Date.now`. */
  now?: () => number;
}

/** Input to `RevisionLog.record`. */
export interface RecordRevisionInput<T = unknown> {
  resourceType: string;
  resourceId: string;
  operation: RevisionOperation;
  snapshot: T | null;
  version?: Version | null;
  scope?: string;
  actor?: string;
  summary?: string;
}

/** Options for `RevisionLog.restore`. */
export interface RestoreOptions<T> {
  /** The store the revision's resource lives in. */
  store: VersionedStore<T>;
  /** Only restore revisions of this scope. */
  scope?: string;
  actor?: string;
}

/** What a restore did. */
export interface RestoreResult {
  /** The revision that was restored. */
  restoredFrom: string;
  /** The new revision holding the value that was replaced, so the restore itself can be undone. */
  revisionId: string;
  resourceType: string;
  resourceId: string;
  /** The resource's version after the restore; `null` when the restore deleted it. */
  version: Version | null;
  deleted: boolean;
}

/** A capped, redacting revision history with restore. */
export interface RevisionLog {
  /** Saves a snapshot and prunes the resource's history to `maxPerResource`. */
  record<T>(input: RecordRevisionInput<T>): Promise<RevisionSummary>;
  /** Revisions newest first, without snapshots. */
  list(query?: RevisionQuery): Promise<RevisionSummary[]>;
  /** One revision with its snapshot redacted. Throws `not_found` (also for another scope). */
  get(id: string, options?: { scope?: string }): Promise<Revision>;
  /**
   * Writes the revision's snapshot back with a compare-and-set (a `null` snapshot deletes) and records
   * the replaced value as a new `restore` revision.
   */
  restore<T>(id: string, options: RestoreOptions<T>): Promise<RestoreResult>;
  /** Copies `value` with every redacted field replaced. */
  redact<T>(value: T): T;
}

/** Field names redacted from snapshots by default. */
export const DEFAULT_REDACTED_FIELDS: readonly string[] = [
  'password',
  'passwordHash',
  'secret',
  'clientSecret',
  'apiKey',
  'token',
  'accessToken',
  'refreshToken',
  'privateKey',
  'smtpPass',
  'imapPass',
  'twoFactor',
];

const REDACTED = '[redacted]';

/** Creates a revision log: snapshot before each change, cap history, redact secrets on the way out, restore. */
export function createRevisionLog(options: RevisionLogOptions = {}): RevisionLog {
  const store = options.store ?? createMemoryRevisionStore();
  const maxPerResource = options.maxPerResource ?? 30;
  const defaultLimit = options.defaultListLimit ?? 20;
  const maxLimit = options.maxListLimit ?? 100;
  const now = options.now ?? Date.now;
  const rules = options.redact ?? DEFAULT_REDACTED_FIELDS;
  const names = new Set(rules.filter((rule): rule is string => typeof rule === 'string'));
  const patterns = rules.filter((rule): rule is RegExp => rule instanceof RegExp);
  const isSecret = (key: string) => names.has(key) || patterns.some((pattern) => pattern.test(key));

  const redactValue = (value: unknown, seen: WeakSet<object>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    let out: unknown;
    if (Array.isArray(value)) out = value.map((item) => redactValue(item, seen));
    else if (value instanceof Date) out = value;
    else {
      const copy: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        // Empty values stay visible, so the agent can still tell "not set" from "set".
        copy[key] =
          isSecret(key) && inner !== null && inner !== undefined && inner !== '' ? REDACTED : redactValue(inner, seen);
      }
      out = copy;
    }
    seen.delete(value);
    return out;
  };

  const summarize = (revision: Revision): RevisionSummary => {
    const summary: Partial<Revision> = { ...revision };
    delete summary.snapshot;
    return summary as RevisionSummary;
  };

  const getRaw = async (id: string, scope: string | undefined): Promise<Revision> => {
    const revision = typeof id === 'string' && id ? await store.get(id) : undefined;
    if (!revision || (scope !== undefined && revision.scope !== scope)) {
      throw new GuardrailError('not_found', `No revision ${JSON.stringify(id)}. List revisions to see the valid ids.`, {
        resource: 'revision',
        id,
      });
    }
    return revision;
  };

  const log: RevisionLog = {
    async record(input) {
      const revision: Revision = {
        id: crypto.randomUUID(),
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        operation: input.operation,
        snapshot: input.snapshot === undefined ? null : structuredClone(input.snapshot),
        createdAt: new Date(now()).toISOString(),
        ...(input.version === undefined ? {} : { version: input.version }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      };
      await store.add(revision);
      await store.prune(
        { resourceType: input.resourceType, resourceId: input.resourceId, scope: input.scope },
        maxPerResource,
      );
      return summarize(revision);
    },

    async list(query = {}) {
      const asked = Math.floor(Number(query.limit ?? defaultLimit));
      const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(asked, maxLimit) : defaultLimit;
      return (await store.list({ ...query, limit })).map(summarize);
    },

    async get(id, { scope } = {}) {
      const revision = await getRaw(id, scope);
      return { ...revision, snapshot: redactValue(revision.snapshot, new WeakSet()) };
    },

    async restore(id, { store: target, scope, actor }) {
      const revision = await getRaw(id, scope);
      const current = await target.get(revision.resourceId);
      const snapshot = revision.snapshot as Parameters<typeof target.compareAndSet>[2];
      const written = await target.compareAndSet(revision.resourceId, current?.version ?? null, snapshot);
      if (!written.ok) {
        const latest = await target.get(revision.resourceId);
        throw versionConflict(
          latest?.version ?? null,
          current?.version ?? null,
          `${revision.resourceType} ${JSON.stringify(revision.resourceId)}`,
        );
      }
      const saved = await log.record({
        resourceType: revision.resourceType,
        resourceId: revision.resourceId,
        operation: 'restore',
        snapshot: current?.value ?? null,
        version: current?.version ?? null,
        summary: `Before restoring revision ${revision.id}`,
        ...(revision.scope === undefined ? {} : { scope: revision.scope }),
        ...(actor === undefined ? {} : { actor }),
      });
      return {
        restoredFrom: revision.id,
        revisionId: saved.id,
        resourceType: revision.resourceType,
        resourceId: revision.resourceId,
        version: written.version,
        deleted: snapshot === null,
      };
    },

    redact(value) {
      return redactValue(value, new WeakSet()) as typeof value;
    },
  };
  return log;
}

/** The reference `RevisionStore`, kept in memory (lost on restart; one process only). */
export function createMemoryRevisionStore(): RevisionStore {
  const rows: Revision[] = [];
  const sameResource = (row: Revision, r: { resourceType: string; resourceId: string; scope?: string }) =>
    row.resourceType === r.resourceType && row.resourceId === r.resourceId && row.scope === r.scope;
  return {
    async add(revision) {
      rows.push(structuredClone(revision));
    },
    async get(id) {
      const row = rows.find((r) => r.id === id);
      return row ? structuredClone(row) : undefined;
    },
    async list(query) {
      const out: Revision[] = [];
      for (let i = rows.length - 1; i >= 0 && out.length < query.limit; i--) {
        const row = rows[i]!;
        if (query.resourceType !== undefined && row.resourceType !== query.resourceType) continue;
        if (query.resourceId !== undefined && row.resourceId !== query.resourceId) continue;
        if (query.scope !== undefined && row.scope !== query.scope) continue;
        out.push(structuredClone(row));
      }
      return out;
    },
    async prune(resource, keep) {
      let seen = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (!sameResource(rows[i]!, resource)) continue;
        seen++;
        if (seen > keep) rows.splice(i, 1);
      }
    },
  };
}
