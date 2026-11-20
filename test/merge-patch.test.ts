import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jsonMergePatch } from '../src/index.ts';

// RFC 7396, Appendix A: [original, patch, result].
const APPENDIX_A: Array<[unknown, unknown, unknown]> = [
  [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
  [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
  [{ a: 'b' }, { a: null }, {}],
  [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
  [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
  [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
  [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
  [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
  [
    ['a', 'b'],
    ['c', 'd'],
    ['c', 'd'],
  ],
  [{ a: 'b' }, ['c'], ['c']],
  [{ a: 'foo' }, null, null],
  [{ a: 'foo' }, 'bar', 'bar'],
  [{ e: null }, { a: 1 }, { e: null, a: 1 }],
  [[1, 2], { a: 'b', c: null }, { a: 'b' }],
  [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
];

describe('jsonMergePatch (RFC 7396)', () => {
  for (const [original, patch, result] of APPENDIX_A) {
    it(`${JSON.stringify(original)} + ${JSON.stringify(patch)} = ${JSON.stringify(result)}`, () => {
      assert.deepEqual(jsonMergePatch(original, patch), result);
    });
  }

  it('applies the example from section 3', () => {
    const target = {
      title: 'Goodbye!',
      author: { givenName: 'John', familyName: 'Doe' },
      tags: ['example', 'sample'],
      content: 'This will be unchanged',
    };
    const patch = { title: 'Hello!', phoneNumber: '+01-123-456-7890', author: { familyName: null }, tags: ['example'] };
    assert.deepEqual(jsonMergePatch(target, patch), {
      title: 'Hello!',
      author: { givenName: 'John' },
      tags: ['example'],
      content: 'This will be unchanged',
      phoneNumber: '+01-123-456-7890',
    });
  });

  it('modifies neither input and skips undefined members', () => {
    const target = { a: { b: 1 }, c: 2 };
    const patch = { a: { b: 3 }, c: undefined };
    const result = jsonMergePatch(target, patch);
    assert.deepEqual(result, { a: { b: 3 }, c: 2 });
    assert.deepEqual(target, { a: { b: 1 }, c: 2 });
    assert.deepEqual(patch, { a: { b: 3 }, c: undefined });
  });

  it('treats "__proto__" as an ordinary member', () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}}');
    const result = jsonMergePatch<Record<string, unknown>>({}, patch);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.deepEqual(Object.keys(result), ['__proto__']);
  });
});
