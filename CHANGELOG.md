# Changelog

## 0.1.2

- The README is now a visual tour: a picture of the package at work, the guide, npm, GitHub and changelog links, and a See it work section. No code changes.

## 0.1.1

- Clearer npm description and keywords, and a homepage with a guide, examples and FAQ: https://oss.saimulislam.com/mcp-guardrails/

## 0.1.0

Initial release.

- `defineTool`: MCP annotations from `kind` (read, write, destructive) plus a guard for dry runs, confirmation, preview tokens and expected versions.
- `createPreviewTokens`: HMAC-SHA-256 preview tokens over WebCrypto, bound to action, resource, actor and payload hash, with expiry, key rotation and distinct errors for tampering, expiry, mismatch and stale state.
- Optimistic concurrency: `checkVersion`, `updateIfUnchanged` and `deleteIfUnchanged` over a storage-agnostic compare-and-set interface, with a conflict error that carries the current version.
- `createRevisionLog`: snapshots before each change, capped history, secret-field redaction, scopes and restore.
- `jsonMergePatch` (RFC 7396), agent-facing errors that list the valid options, and `instructions()` for the server-instructions text.
- `mcp-guardrails/sdk`: `defineTool`, `registerTools` and `revisionTools` for the official TypeScript SDK.
