import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const contract = Object.freeze({ id: 'soft-ui.windows', version: '1.0.0' });
export async function readConfiguration(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--runtime-config') throw new Error('Expected --runtime-config <private file>');
  const config = JSON.parse(await readFile(resolve(argv[1]), 'utf8'));
  const bridge = config.bridges?.find(item => item.slot === 'main');
  if (config.format !== 'world-hub.run/v1' || typeof config.componentId !== 'string' || typeof config.stateDir !== 'string'
      || !config.peers || !Array.isArray(config.bindings) || !bridge || typeof bridge.principal !== 'string'
      || typeof bridge.token !== 'string' || !bridge.token || !Array.isArray(bridge.publish) || !Array.isArray(bridge.subscribe)
      || typeof config.topics?.commands !== 'string' || typeof config.topics?.events !== 'string') throw new Error('Invalid private module configuration');
  const endpoint = new URL(bridge.endpoint);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('This deployment requires a loopback Hub');
  return config;
}
export function boundPrincipals(config, role) {
  const selected = config.bindings.filter(binding => binding.contract?.id === contract.id && binding.contract?.version === contract.version
    && (role === 'provider' ? binding.from === config.componentId : binding.to === config.componentId));
  const ids = selected.map(binding => role === 'provider' ? binding.to : binding.from);
  const principals = ids.map(id => config.peers[id]?.principal);
  if (principals.some(principal => typeof principal !== 'string' || !principal) || !principals.length
      || new Set(principals).size !== principals.length || (role === 'consumer' && principals.length !== 1)) throw new Error('Select a valid Soft UI capability binding');
  return principals;
}
