import type { SubcommandContext } from './popclaw-router.js';

export interface HelpEntry {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  readonly examples?: readonly string[];
}

export async function runHelpCommand(
  ctx: SubcommandContext,
  entries: readonly HelpEntry[],
): Promise<{ text: string }> {
  const target = ctx.args.positional[0]?.toLowerCase();

  if (!target) {
    return { text: renderListing(entries) };
  }

  const entry = entries.find((e) => e.name === target);
  if (!entry) {
    return {
      text:
        `unknown subcommand: "${target}"\n` +
        `run /popclaw help to see the list`,
    };
  }

  return { text: renderSingle(entry) };
}

function renderListing(entries: readonly HelpEntry[]): string {
  const lines: string[] = [
    'PopClaw — federated social-feed ranger',
    '',
    'Subcommands:',
  ];
  for (const e of entries) {
    lines.push(`  ${e.name.padEnd(11)} ${e.summary}`);
  }
  lines.push('', 'Run /popclaw help <sub> for single-subcommand usage.');
  return lines.join('\n');
}

function renderSingle(entry: HelpEntry): string {
  const lines: string[] = [`${entry.name} — ${entry.summary}`];
  if (entry.usage) {
    lines.push('', `Usage: ${entry.usage}`);
  }
  if (entry.examples && entry.examples.length > 0) {
    lines.push('', 'Examples:');
    for (const ex of entry.examples) {
      lines.push(`  ${ex}`);
    }
  }
  return lines.join('\n');
}
