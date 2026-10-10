import { readBounded } from './paths.mjs';
export const completionCommands = ['inspect-template', 'preview-template', 'instantiate-template', 'create-template',
  'upgrade-plan', 'upgrade', 'staged-upgrade-plan', 'staged-upgrade', 'upgrade-history', 'rollback-plan', 'rollback-upgrade', 'recover-upgrade', 'isolation-probe', 'isolation-review'];
export const completionHelp = `
  world-hub-pack isolation-probe --docker absolute-executable --endpoint local-daemon-endpoint
  world-hub-pack isolation-review <pack-directory> --isolation policy.json [--node executable]
  world-hub-pack start --root directory --instance id --trust package-digest --isolation policy.json --isolation-trust isolation-digest
  world-hub-pack inspect-template <template-directory>
  world-hub-pack preview-template|instantiate-template <template-directory> --values values.json [--pack-id id --pack-version version --pack-title title] [--revision template-revision] [--destination new-directory --preview-digest reviewed-digest --acknowledge-licenses true]
  world-hub-pack create-template <pack-directory> --manifest template.json --destination new-directory --acknowledge-licenses true
  world-hub-pack upgrade-plan|upgrade --root directory --instance id --candidate pack-directory --state-policies policies.json [--trust reviewed-digest] [--node executable --python executable]
  world-hub-pack staged-upgrade-plan|staged-upgrade --root directory --instance old-id --candidate pack-directory --new-instance new-id --backup-destination new-private.whbackup --state-policy fresh|provider [--state-policies policies.json] [--trust reviewed-digest] [--node executable --python executable]
  world-hub-pack upgrade-history --root directory --instance id
  world-hub-pack rollback-plan|rollback-upgrade|recover-upgrade --root directory --instance id --transaction id [--trust reviewed-digest] [--node executable --python executable]

Template instantiation is static and creates a new locked Pack; it never runs programs.
Upgrade and rollback require stopped instances and exact plan digests. Program authors define data compatibility and migration code.
An explicit rollback restores a reviewed private snapshot and can discard newer data; it is never automatic after later runs.
`;
export function parseCompletionArgs(argv) {
  if (['staged-upgrade-plan', 'staged-upgrade'].includes(argv[0])) {
    if (argv.length === 2 && ['--help', '-h'].includes(argv[1])) return { help: true };
    const command = argv[0], options = {}, seen = new Set();
    const flags = { '--root': 'root', '--instance': 'instanceId', '--candidate': 'candidate', '--new-instance': 'newInstanceId', '--backup-destination': 'backupDestination',
      '--state-policy': 'statePolicy', '--state-policies': 'statePoliciesFile', '--trust': 'trust', '--node': 'nodePath', '--python': 'pythonPath' };
    for (let index = 1; index < argv.length; index += 2) { const key = argv[index], value = argv[index + 1];
      if (!Object.hasOwn(flags, key) || seen.has(key) || !value || value.startsWith('--') || command === 'staged-upgrade-plan' && key === '--trust') throw new Error('Unknown, duplicate or incomplete option: ' + key);
      seen.add(key); options[flags[key]] = value; }
    for (const key of ['root', 'instanceId', 'candidate', 'newInstanceId', 'backupDestination', 'statePolicy', ...(command === 'staged-upgrade' ? ['trust'] : [])]) if (!options[key]) throw new Error('Required option is missing: ' + key);
    if (!['fresh', 'provider'].includes(options.statePolicy) || (options.statePolicy === 'provider') !== Boolean(options.statePoliciesFile)) throw new Error('Choose fresh without policies or provider with --state-policies.');
    return { command, options };
  }
  if (['isolation-probe', 'isolation-review'].includes(argv[0])) {
    if (argv.length === 2 && ['--help', '-h'].includes(argv[1])) return { help: true };
    const command = argv[0], options = {}, seen = new Set(); let index = 1, packDirectory;
    if (command === 'isolation-review') { packDirectory = argv[index++]; if (!packDirectory || packDirectory.startsWith('--')) throw new Error('Missing package directory'); }
    const flags = command === 'isolation-probe' ? { '--docker': 'dockerPath', '--endpoint': 'endpoint' } : { '--isolation': 'isolationFile', '--node': 'nodePath', '--python': 'pythonPath' };
    for (; index < argv.length; index += 2) { const key = argv[index], value = argv[index + 1]; if (!Object.hasOwn(flags, key) || seen.has(key) || !value || value.startsWith('--')) throw new Error('Unknown, duplicate or incomplete option: ' + key); seen.add(key); options[flags[key]] = value; }
    for (const key of command === 'isolation-probe' ? ['dockerPath', 'endpoint'] : ['isolationFile']) if (!options[key]) throw new Error('Required isolation option: ' + key);
    return { command, packDirectory, options };
  }
  const command = argv[0], templateCommand = command.includes('template');
  if (!completionCommands.includes(command)) throw new Error('Unknown completion operation');
  if (argv.length === 2 && ['--help', '-h'].includes(argv[1])) return { help: true };
  let index = 1, packDirectory;
  if (templateCommand) { packDirectory = argv[index++]; if (!packDirectory || packDirectory.startsWith('--')) throw new Error('Missing source directory'); }
  const flags = { '--root': 'root', '--instance': 'instanceId', '--candidate': 'candidate', '--state-policies': 'statePoliciesFile', '--transaction': 'transactionId',
    '--trust': 'trust', '--node': 'nodePath', '--python': 'pythonPath', '--values': 'valuesFile', '--manifest': 'templateFile', '--destination': 'destination',
    '--revision': 'expectedRevision', '--preview-digest': 'expectedPreviewDigest', '--acknowledge-licenses': 'redistributionAcknowledged',
    '--pack-id': 'packId', '--pack-version': 'packVersion', '--pack-title': 'packTitle' };
  const accepted = command === 'inspect-template' ? [] : command === 'create-template' ? ['--manifest', '--destination', '--acknowledge-licenses']
    : templateCommand ? ['--values', '--pack-id', '--pack-version', '--pack-title', '--revision', ...(command === 'instantiate-template' ? ['--destination', '--preview-digest', '--acknowledge-licenses'] : [])]
      : ['--root', '--instance', ...(['upgrade-plan', 'upgrade'].includes(command) ? ['--candidate', '--state-policies'] : command === 'upgrade-history' ? [] : ['--transaction']),
        ...(command === 'upgrade-history' ? [] : ['--node', '--python']), ...(['upgrade', 'rollback-upgrade', 'recover-upgrade'].includes(command) ? ['--trust'] : [])];
  const options = {}, seen = new Set();
  for (; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!accepted.includes(key) || seen.has(key) || !value || value.startsWith('--')) throw new Error('Unknown, duplicate or incomplete option: ' + key);
    seen.add(key); options[flags[key]] = value;
  }
  const required = command === 'create-template' ? ['templateFile', 'destination']
    : command === 'instantiate-template' ? ['valuesFile', 'destination', 'expectedRevision', 'expectedPreviewDigest']
      : command === 'preview-template' ? ['valuesFile'] : command === 'inspect-template' ? []
        : ['root', 'instanceId', ...(['upgrade-plan', 'upgrade'].includes(command) ? ['candidate', 'statePoliciesFile'] : command === 'upgrade-history' ? [] : ['transactionId']),
          ...(['upgrade', 'rollback-upgrade', 'recover-upgrade'].includes(command) ? ['trust'] : [])];
  for (const key of required) if (!options[key]) throw new Error('Required option is missing: ' + key);
  if (['create-template', 'instantiate-template'].includes(command)) {
    if (options.redistributionAcknowledged !== 'true') throw new Error('--acknowledge-licenses true is required');
    options.redistributionAcknowledged = true;
  }
  return { command, packDirectory, options };
}
export async function runCompletion({ command, packDirectory, options }) {
  const parse = async file => JSON.parse((await readBounded(file)).toString('utf8'));
  if (['staged-upgrade-plan', 'staged-upgrade'].includes(command)) {
    const api = await import('./staged-upgrade.mjs');
    return api[command === 'staged-upgrade-plan' ? 'previewStagedUpgrade' : 'createStagedUpgrade']({ ...options, ...(options.statePoliciesFile ? { statePolicies: await parse(options.statePoliciesFile) } : {}) });
  }
  if (command === 'isolation-probe') return (await import('./isolation.mjs')).probeIsolation(options);
  if (command === 'isolation-review') {
    const plan = await (await import('./package.mjs')).inspectPackage(packDirectory, options);
    return { review: plan, isolation: await (await import('./isolation.mjs')).reviewIsolationPackage(plan, await parse(options.isolationFile)) };
  }
  if (command.includes('template')) {
    const api = await import('./template.mjs');
    if (command === 'inspect-template') return api.inspectTemplate(packDirectory);
    if (command === 'create-template') return api.createTemplate(packDirectory, { ...options, template: await parse(options.templateFile) });
    const identity = Object.fromEntries([['id', options.packId], ['version', options.packVersion], ['title', options.packTitle]].filter(([, value]) => value !== undefined));
    const input = { ...options, values: await parse(options.valuesFile), ...(Object.keys(identity).length ? { identity } : {}) };
    return command === 'preview-template' ? api.previewTemplate(packDirectory, input) : api.instantiateTemplate(packDirectory, input);
  }
  const api = await import('./upgrade.mjs');
  if (options.statePoliciesFile) options = { ...options, statePolicies: await parse(options.statePoliciesFile) };
  const operation = { 'upgrade-plan': 'previewUpgrade', upgrade: 'upgradeInstance', 'upgrade-history': 'inspectUpgradeHistory',
    'rollback-plan': 'previewRollback', 'rollback-upgrade': 'rollbackUpgrade', 'recover-upgrade': 'recoverUpgrade' }[command];
  return api[operation](options);
}
