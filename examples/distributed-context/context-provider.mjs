// Convenience entry point for one independently configured provider program.
import { join } from 'node:path';
import { startContextProgram } from './context-program.mjs';
import { cliLifecycle, isMain, loadSettings } from './lib/program-kit.mjs';

export function providerSettings(settings, provider) {
  return { ...settings, stateDir: join(settings.stateDir, 'providers', provider.id), context: provider.context,
    contextPeer: provider.peer, contextProviderId: provider.id, trackDialogue: provider.trackDialogue === true };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2), remaining = [];
  let id;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider' && argv[i + 1]) id = argv[++i];
    else remaining.push(argv[i]);
  }
  const settings = loadSettings(remaining);
  const provider = id === undefined ? settings.contextProviders?.[0] : settings.contextProviders?.find(provider => provider.id === id);
  if (!provider) throw new Error('Choose a configured source with --provider <id>');
  startContextProgram(providerSettings(settings, provider))
    .then(program => cliLifecycle(program, { providerId: provider.id }))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
