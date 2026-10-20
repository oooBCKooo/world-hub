// Noninteractive management client. All operations use the public loopback API.
import { open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ManagementClient, MANAGEMENT_OPERATIONS, getManagementOperation, redactManagementResult } from '../sdk/javascript/management-client.mjs';

const MAX_INPUT = 1024 * 1024;
const usage = message => Object.assign(new Error(message), { code: 'CLI_USAGE', exitCode: 2 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const booleans = new Set(['accept', 'stop-owned', 'data-acknowledged', 'data-compatibility-acknowledged', 'public-data-acknowledged', 'redistribution-acknowledged', 'allow-private-network', 'remove-unreferenced-bodies']);
const numbers = new Set(['limit', 'seq']);
const strings = new Set(['expected-revision', 'review-id', 'program-id', 'group-id', 'directory', 'path', 'destination', 'scope', 'target-id', 'profile-id', 'data-id', 'source-id', 'entry-id', 'sha256', 'transaction-id', 'key', 'action', 'id', 'title', 'version', 'purpose', 'data-policy', 'configuration-policy', 'expected-run-id', 'bridge-name', 'license']);
const arrays = new Set(['program-ids', 'profile-ids', 'keep-program-ids', 'keep-profile-ids', 'replace-profile-ids', 'connection-ids']);
const camel = key => key.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());

export const MANAGEMENT_HELP = `World Hub — local management CLI (no interactive terminal UI)

  world-hub start [--config FILE] [--data-dir DIR] [--port PORT]
  world-hub --check [startup options]
  world-hub --version
  world-hub operations [--json]
  world-hub <command> [ID] [options]
  world-hub manage <operation.name> [options]

  status | state | log | message get
  module list|inspect|preview|register|review|start|stop|logs
  module configuration preview|apply     module execution save
  startup get|status|save|review|start    execution status
  group ... | bridge control | annotation save | wiring defaults ...
  resource body|configuration|data|cleanup ...
  version module|group ... | uninstall module|group ...
  source ... | workshop ... | artifact ... | external ... | creator ...
  path known|browse | environment detect

  --help, -h          Show command help, input schema and review requirements
  --hub ORIGIN       Loopback HTTP origin (default WORLD_HUB_URL or http://127.0.0.1:8790)
  --input FILE|-     JSON object from a file or stdin (maximum 1 MiB)
  --json             Compact JSON on stdout; errors are JSON on stderr
  --raw              Exact retained JSON text, only for message get and log
  --timeout MS       Request timeout, 1–3600000 (default 30000)
  --review-id ID     Review previously returned by a separate preview/review
  --accept           Explicitly accept that review; never creates a review
  --expected-revision ID | --directory DIR | --path FILE | --seq N
  --secrets-file FILE  external apply only: new private credentials file

Complex settings, bindings, policies, plans and source descriptors use --input.
Use operations --json for the complete command catalog and schemas.
POST requests acquire their own CSRF token. Writes are never retried automatically.
Exit codes: 0 success, 1 API/network failure, 2 invalid arguments/input, 130 interrupted.
`;

function assign(input, key, value) {
  if (['__proto__', 'prototype', 'constructor'].includes(key)) throw usage('Unsafe input field.');
  if (Object.hasOwn(input, key) && JSON.stringify(input[key]) !== JSON.stringify(value)) throw usage(`Conflicting values for ${key}; use one source of input.`);
  input[key] = value;
}

export function parseManagementArgs(argv) {
  const words = [], fields = Object.create(null), options = { json: false, raw: false, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('-')) { words.push(arg); continue; }
    const name = arg === '-h' ? 'help' : arg.startsWith('--') ? arg.slice(2) : '';
    if (seen.has(name)) throw usage(`Duplicate option: ${arg}.`);
    seen.add(name);
    if (['json', 'raw', 'help'].includes(name)) { options[name] = true; continue; }
    if (booleans.has(name)) { assign(fields, name === 'accept' ? 'accepted' : camel(name), true); continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--') || value === '-h') throw usage(`Missing value for ${arg}.`);
    if (['hub', 'input', 'timeout', 'secrets-file'].includes(name)) { options[camel(name)] = value; continue; }
    if (numbers.has(name)) {
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw usage(`${arg} requires a safe nonnegative integer.`);
      assign(fields, camel(name), Number(value));
    } else if (strings.has(name)) assign(fields, camel(name), value);
    else if (arrays.has(name)) {
      const values = value.split(',');
      if (values.some(item => !item)) throw usage(`${arg} requires comma-separated nonempty values.`);
      assign(fields, camel(name), values);
    } else throw usage(`Unknown option: ${arg}. Use --input for structured operation fields.`);
  }
  if (options.timeout !== undefined && (!/^\d+$/u.test(options.timeout) || Number(options.timeout) < 1 || Number(options.timeout) > 3600000)) throw usage('--timeout requires milliseconds from 1 through 3600000.');
  if (options.raw && options.json) throw usage('Choose --raw or --json.');
  let operation, positional = [];
  if (words[0] === 'manage') { operation = getManagementOperation(words[1]); positional = words.slice(2); }
  else {
    operation = MANAGEMENT_OPERATIONS.filter(entry => entry.command.every((word, index) => words[index] === word)).sort((a, b) => b.command.length - a.command.length)[0];
    if (operation) positional = words.slice(operation.command.length);
  }
  if (words[0] === 'operations') {
    if (words.length !== 1 || Object.keys(fields).length || options.input || options.raw || options.secretsFile) throw usage('operations takes only --json or --help.');
    return { options, catalog: true, fields };
  }
  if (!operation) {
    // A command family can display its relevant subset without contacting a Hub.
    const prefix = words[0] === 'manage' ? [] : words;
    if (options.help && !options.input && !Object.keys(fields).length && MANAGEMENT_OPERATIONS.some(entry => prefix.every((word, index) => entry.command[index] === word))) return { options, family: prefix, fields };
    throw usage(`Unknown command: ${words.join(' ') || '(empty)'}. Use world-hub --help or operations.`);
  }
  const params = operation.params ?? (operation.name === 'messages.get' ? ['seq'] : []);
  if (positional.length > params.length) throw usage(`Too many arguments for ${operation.command.join(' ')}.`);
  positional.forEach((value, index) => {
    if (params[index] === 'seq') {
      if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw usage('Message sequence must be a positive safe integer.');
      value = Number(value);
    }
    assign(fields, params[index], value);
  });
  // External grants use a run-scoped numeric revision; module/group revisions
  // are opaque strings and must never be coerced.
  if (operation.name === 'external.preview' && Object.hasOwn(fields, 'expectedRevision')) {
    if (!/^\d+$/u.test(fields.expectedRevision) || !Number.isSafeInteger(Number(fields.expectedRevision))) throw usage('--expected-revision must be a safe integer for external preview.');
    fields.expectedRevision = Number(fields.expectedRevision);
  }
  if (options.raw && !['messages.get', 'hub.log'].includes(operation.name)) throw usage('--raw is available only for message get and log.');
  if (options.secretsFile && operation.name !== 'external.apply') throw usage('--secrets-file is available only for external apply.');
  if (operation.name === 'external.apply' && !options.secretsFile && !options.help) throw usage('external apply requires --secrets-file NEW_FILE to deliver generated credentials privately.');
  return { options, operation, fields };
}

async function readInput(path, { cwd, stdin }) {
  if (!path) return Object.create(null);
  let chunks = [], size = 0, file;
  try {
    if (path !== '-') {
      file = await open(resolve(cwd, path), 'r');
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_INPUT) throw usage('--input must be a regular JSON file of at most 1 MiB.');
    }
    for await (const chunk of file ? file.createReadStream({ autoClose: false }) : stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT) throw usage('--input exceeds 1 MiB.');
      chunks.push(bytes);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/u, '')); }
    catch { throw usage('--input must contain valid JSON; file contents are not echoed.'); }
    if (!plain(value)) throw usage('--input must contain a JSON object.');
    for (const key of Object.keys(value)) if (['__proto__', 'constructor', 'prototype'].includes(key)) throw usage('Unsafe input field.');
    return value;
  } catch (error) {
    if (error.exitCode) throw error;
    throw usage(`Cannot read --input (${error.code ?? 'read failed'}).`);
  } finally { await file?.close(); }
}

export async function runManagementCli(argv, { cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, clientFactory = options => new ManagementClient(options) } = {}) {
  let parsed, privateFile, interrupted = false, completed = false;
  const controller = new AbortController();
  const onInterrupt = () => { interrupted = true; controller.abort(); };
  try {
    parsed = parseManagementArgs(argv);
    const { options, operation, fields } = parsed;
    const print = value => stdout.write(JSON.stringify(value, null, options.json ? undefined : 2) + '\n');
    if (parsed.catalog) { print({ operations: MANAGEMENT_OPERATIONS }); return 0; }
    if (parsed.family) {
      stdout.write(MANAGEMENT_HELP + '\n' + MANAGEMENT_OPERATIONS.filter(entry => parsed.family.every((word, index) => entry.command[index] === word)).map(entry => `  ${entry.command.join(' ')} — ${entry.description}`).join('\n') + '\n');
      return 0;
    }
    if (options.help) { print(operation); return 0; }
    const input = await readInput(options.input, { cwd, stdin });
    for (const [key, value] of Object.entries(fields)) assign(input, key, value);
    const client = clientFactory({ url: options.hub ?? env.WORLD_HUB_URL ?? 'http://127.0.0.1:8790', timeoutMs: Number(options.timeout ?? 30000) });
    let privatePath;
    if (options.secretsFile) {
      privatePath = resolve(cwd, options.secretsFile);
      // Resolve the existing parent before creating exactly one new file. Never
      // overwrite a credential file or follow a symlink at its final component.
      if (await realpath(dirname(privatePath)) !== dirname(privatePath)) throw usage('--secrets-file parent must be a resolved directory without symlink aliases.');
      try { privateFile = await open(privatePath, 'wx', 0o600); }
      catch (error) { throw usage(`Cannot create private credentials file (${error.code ?? 'write failed'}); no request was sent.`); }
    }
    process.once('SIGINT', onInterrupt);
    const result = await client.execute(operation.name, input, { signal: controller.signal, ...(privateFile ? { includeSecrets: true } : {}) });
    completed = true;
    if (privateFile) {
      await privateFile.writeFile(JSON.stringify(result, null, 2) + '\n');
      await privateFile.sync();
      print({ ...redactManagementResult(result), credentialsFile: privatePath });
    } else if (options.raw) stdout.write(result.rawJSON + '\n');
    else print(result);
    return 0;
  } catch (error) {
    const detail = redactManagementResult({ code: error.code ?? 'CLI_FAILED', message: error.message, ...(error.status ? { status: error.status } : {}), ...(error.details ? { details: error.details } : {}), ...(error.outcome ? { outcome: error.outcome, retrySafe: error.retrySafe } : {}), ...(completed ? { outcome: 'applied', retrySafe: false } : {}), ...(privateFile ? { credentialsFileMayBeIncomplete: true } : {}) });
    if (privateFile) { try { await privateFile.writeFile(JSON.stringify({ error: detail }, null, 2) + '\n'); await privateFile.sync(); } catch {} }
    if (parsed?.options.json || argv.includes('--json')) stderr.write(JSON.stringify({ error: detail }) + '\n');
    else stderr.write(`${detail.code}: ${detail.message}${detail.outcome === 'unknown' ? ' Outcome unknown; inspect current state before another write.' : ''}${privateFile ? ' Private credentials file may be incomplete; inspect the grant before retrying.' : ''}\n`);
    const invalid = /^(?:CLI_USAGE|MANAGEMENT_(?:INPUT|URL|OPTIONS|REVIEW|ACCEPTANCE|OPERATION_UNKNOWN))/u.test(detail.code);
    return interrupted ? 130 : error.exitCode ?? (invalid ? 2 : 1);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    await privateFile?.close();
  }
}
