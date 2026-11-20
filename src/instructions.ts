import type { GuardedTool } from './define.ts';

/** The parts of a guarded tool `instructions` reads. Any `GuardedTool` fits. */
export type InstructionTool = Pick<
  GuardedTool<never, never>,
  'name' | 'confirm' | 'previewTool' | 'previewTtlMs' | 'version'
>;

/** Options for `instructions`. Conventions are inferred from `tools`; the flags turn lines on or off. */
export interface InstructionsOptions {
  /** Opening paragraph: what the server is for. */
  intro?: string;
  /** Guarded tools; their confirm, preview and version settings decide which rules are written. */
  tools?: readonly InstructionTool[];
  /** The read tool pattern agents call before an update. Default `*_get`. */
  readTool?: string;
  /** Write the version rule with this field name, or `false` to leave it out. Default: inferred. */
  version?: string | false;
  /** Write the dryRun → confirm rule. Default: inferred. */
  confirm?: boolean;
  /** Write the preview-token rule. Default: inferred. */
  preview?: boolean;
  /** Write the "unknown fields are rejected" rule. Default true. */
  unknownFields?: boolean;
  /** Write the JSON Merge Patch rule. Default false. */
  mergePatch?: boolean;
  /** Write the undo rule; `true` uses `revisions_list` and `revisions_restore`. Default false. */
  revisions?: boolean | { list: string; restore: string };
  /** Write the rule on reading error results. Default true. */
  errors?: boolean;
  /** More rules, appended as they are. */
  rules?: readonly string[];
}

const names = (tools: readonly InstructionTool[]) => tools.map((tool) => tool.name).join(', ');

function minutes(ms: number): string {
  const value = Math.round(ms / 60000);
  return `${value} minute${value === 1 ? '' : 's'}`;
}

/**
 * Builds the server-instructions text (the `instructions` option of an MCP server) that teaches agents
 * the conventions the guarded tools enforce. Returns plain text: an intro, then one rule per line.
 */
export function instructions(options: InstructionsOptions = {}): string {
  const tools = options.tools ?? [];
  const rules: string[] = [];
  const readTool = options.readTool ?? '*_get';

  const versionFields = [...new Set(tools.flatMap((tool) => (tool.version ? [tool.version.field] : [])))];
  const versionField = options.version === undefined ? versionFields.join(' / ') : options.version;
  if (versionField) {
    rules.push(
      `Call ${readTool} before an update and pass ${versionField} from that response. If the data changed in the meantime ` +
        'the update is refused with version_conflict and the current version: read again and redo the change.',
    );
  }

  if (options.mergePatch) {
    rules.push(
      'Updates take a JSON Merge Patch: send only the fields that change; nested objects merge; lists replace (send the whole list); null clears a field.',
    );
  }

  const flagTools = tools.filter((tool) => tool.confirm === 'flag');
  if (options.confirm ?? flagTools.length > 0) {
    const which = flagTools.length ? ` (${names(flagTools)})` : '';
    rules.push(
      `Deletes and bulk operations${which}: call with dryRun: true first, show the user the plan, then call again with confirm: true once they agree.`,
    );
  }

  const previewTools = tools.filter((tool) => tool.confirm === 'preview');
  if (options.preview ?? previewTools.length > 0) {
    const sameTool = previewTools.filter((tool) => !tool.previewTool);
    const separate = previewTools.filter((tool) => tool.previewTool);
    const ttls = [...new Set(previewTools.flatMap((tool) => (tool.previewTtlMs ? [tool.previewTtlMs] : [])))];
    const expiry = ttls.length === 1 ? `Tokens expire after ${minutes(ttls[0]!)}` : 'Tokens expire';
    if (sameTool.length || !separate.length) {
      const which = sameTool.length ? `${names(sameTool)}: ` : 'Tools that take a previewToken: ';
      rules.push(
        `${which}call with dryRun: true first, show the user the plan, then call again with the same arguments plus previewToken and confirm: true.`,
      );
    }
    for (const tool of separate) {
      rules.push(`${tool.name}: call ${tool.previewTool} first, then pass its previewToken + confirm: true.`);
    }
    rules.push(`${expiry} and only work for the arguments that were previewed; preview again after any change.`);
  }

  if (options.unknownFields ?? true) {
    rules.push('Never invent fields or values: unknown fields and options are rejected with the valid options.');
  }

  if (options.revisions) {
    const { list, restore } =
      options.revisions === true ? { list: 'revisions_list', restore: 'revisions_restore' } : options.revisions;
    rules.push(`Every change saves a revision: ${list} → ${restore} to undo.`);
  }

  if (options.errors ?? true) {
    rules.push(
      'A refused call returns an error that names the problem and how to fix it. Follow the message; never repeat a refused call unchanged.',
    );
  }

  rules.push(...(options.rules ?? []));
  const body = rules.length ? `Rules:\n${rules.map((rule) => `- ${rule}`).join('\n')}` : '';
  return [options.intro?.trim(), body].filter(Boolean).join('\n\n');
}
