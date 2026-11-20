import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GuardrailError,
  assertKnownFields,
  assertOption,
  closestMatch,
  confirmationRequired,
  invalidOption,
  isGuardrailError,
  toolError,
} from '../src/index.ts';

describe('agent-facing errors', () => {
  it('invalid_option lists the valid values and suggests the closest one', () => {
    const error = invalidOption('status', 'publishd', ['draft', 'published', 'archived']);
    assert.equal(error.code, 'invalid_option');
    assert.deepEqual(error.details, {
      field: 'status',
      value: 'publishd',
      validOptions: ['draft', 'published', 'archived'],
      didYouMean: 'published',
    });
    assert.equal(
      error.message,
      '"publishd" is not a valid status. Valid options: "draft", "published", "archived". Did you mean "published"?',
    );
    assert.equal(assertOption('status', 'draft', ['draft', 'published']), 'draft');
    assert.throws(
      () => assertOption('status', 'gone', ['draft']),
      (e) => isGuardrailError(e) && e.code === 'invalid_option',
    );
  });

  it('unknown_field lists the known fields', () => {
    assert.throws(
      () => assertKnownFields({ titel: 'x', body: 'y', colour: 'red' }, ['title', 'body', 'status'], 'patch'),
      (error: unknown) => {
        assert.ok(isGuardrailError(error));
        assert.equal(error.code, 'unknown_field');
        assert.deepEqual(error.details.fields, ['titel', 'colour']);
        assert.deepEqual(error.details.knownFields, ['title', 'body', 'status']);
        assert.deepEqual(error.details.didYouMean, { titel: 'title' });
        assert.match(
          error.message,
          /^Unknown fields in patch: "titel", "colour"\. Known fields: "title", "body", "status"\./,
        );
        return true;
      },
    );
    assertKnownFields({ title: 'x' }, ['title']);
  });

  it('confirmation_required says how to confirm', () => {
    const error = confirmationRequired('sites_delete');
    assert.equal(error.code, 'confirmation_required');
    assert.match(error.message, /confirm: true/);
  });

  it('suggests only close matches', () => {
    assert.equal(closestMatch('Title', ['title', 'body']), 'title');
    assert.equal(closestMatch('zzzz', ['title', 'body']), undefined);
  });

  it('serializes as { error: { code, message, ...details } }', () => {
    const result = toolError(new GuardrailError('version_conflict', 'Changed.', { currentVersion: 4 }));
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      error: { currentVersion: 4, code: 'version_conflict', message: 'Changed.' },
    });
    assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent);
  });

  it('lets onError map other errors to agent-facing ones', () => {
    const result = toolError(new Error('rate limited'), {
      onError: () => new GuardrailError('rate_limited', 'Too many requests. Wait a minute and try again.'),
    });
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'rate_limited');
  });
});
