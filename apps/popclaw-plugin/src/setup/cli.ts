import { setup, type SetupOptions } from './setup.js';
/** Wire this function to the public dispatcher only for the `setup` subcommand. */
export async function setupCli(args: string[], packagePath?: string) {
  const options: Record<string, unknown> = packagePath ? { package: packagePath } : {};
  const flags: Record<string, string> = { '--package': 'package', '--host': 'host', '--root': 'root', '--project': 'project', '--app-root': 'appRoot', '--claude-profile': 'claudeProfile' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--plan') { options.plan = true; continue; }
    if (arg === '--create-identity') { options.createIdentity = true; continue; }
    const key = flags[arg];
    const value = args[i + 1];
    if (!key || !value || value.startsWith('--')) throw new Error(`Unknown or incomplete setup argument: ${arg}`);
    options[key] = value;
    i += 1;
  }
  if (!options.package || !options.host) throw new Error('Usage: popclaw setup --package ABSOLUTE_EXTRACTED_PACKAGE --host claude|codex|both [--root ABSOLUTE_ROOT] [--create-identity] [--plan]');
  return setup(options as unknown as SetupOptions);
}
