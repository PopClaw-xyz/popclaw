import type { HostAdapter } from '../host/host-adapter.js';
import { FALLBACK_LORE_HOUSE_URL } from '../lshow/sources/fallback.js';
import { PluginConfig } from './schema.js';

export async function loadPluginConfig(host: HostAdapter): Promise<PluginConfig> {
  const raw = await host.config.loadJson('plugin');
  if (raw === null) {
    // Zero-config first boot: generate a default pointing at the public
    // lore-house and persist it so the owner can find and edit it. Only runs
    // when the file is absent — an existing file is never rewritten (P-006).
    // World is offered separately. Existing lists and joins are preserved.
    const defaults = { lore_houses: [FALLBACK_LORE_HOUSE_URL] };
    try {
      await host.config.saveJson('plugin', defaults);
    } catch {
      // Persisting is best-effort; an unwritable config dir must not brick boot.
    }
    return PluginConfig.parse(defaults);
  }
  return PluginConfig.parse(raw);
}
