import { isPlainObject } from './encoding.ts';

/**
 * Applies a JSON Merge Patch (RFC 7396): objects merge recursively, `null` removes a member, and arrays
 * and other values replace. Neither input is modified. `undefined` members are skipped, for in-memory
 * callers. To change one item of a list, the agent sends the whole list.
 */
export function jsonMergePatch<T = unknown>(target: unknown, patch: unknown): T {
  return apply(target, patch) as T;
}

function apply(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch === undefined ? target : structuredClone(patch);
  const result: Record<string, unknown> = {};
  if (isPlainObject(target)) {
    for (const [key, value] of Object.entries(target)) define(result, key, value);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (value !== undefined)
      define(result, key, apply(Object.hasOwn(result, key) ? result[key] : undefined, value));
  }
  return result;
}

// defineProperty keeps a "__proto__" member an ordinary own property instead of changing the prototype.
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
