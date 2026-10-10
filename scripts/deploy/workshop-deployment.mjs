import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const marker = '// WORLD_HUB_WORKSHOP_GATEWAY_V1';
const anchor = 'function routeRequest(req, res, defaultProto) {';
const routeAnchor = '  // 0. WeChat security verification file';
const psString = value => "'" + String(value).replaceAll("'", "''") + "'";

function publicAddress(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/workshop/') {
    throw new Error('publicBaseUrl must be an HTTPS origin followed by /workshop/, without credentials, query, fragment, or an explicit port.');
  }
  return url;
}

function gatewayInsertion(port, publicBaseUrl) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port.');
  const origin = publicAddress(publicBaseUrl).origin;
  // The proxy owns the forwarding headers. A public caller cannot choose a
  // different backend or make HTTP appear to be HTTPS.
  return `${marker}
// WORLD_HUB_PRIVATE_STATIC_GUARD_V1
function isWorldHubPrivateStaticPath(pathname) {
  let decoded = pathname;
  // The legacy static handler decodes the path and uses Windows filesystem
  // spelling. Also cover encoded separators and trailing-dot/ADS aliases.
  for (let i = 0; i < 3; i++) {
    let next;
    try { next = decodeURIComponent(decoded); } catch (_) { break; }
    if (next === decoded) break;
    decoded = next;
  }
  const pieces = [];
  for (let piece of decoded.replaceAll('\\\\', '/').split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') { pieces.pop(); continue; }
    piece = piece.split(':', 1)[0].replace(/[. ]+$/g, '').toLowerCase();
    if (piece) pieces.push(piece);
  }
  if (pieces.some(piece => piece === '.git' || piece === '.env' || piece.startsWith('.env.') || piece === 'server-data')) return true;
  const staticPieces = ['exams', 'practice'].includes(pieces[0]) ? pieces.slice(1) : pieces;
  if (staticPieces.length === 1 && ['server.js', 'daemon.bat'].includes(staticPieces[0])) return true;
  return staticPieces.some(piece => /\\.(?:pfx|pem|key|exe|ps1|log)$/i.test(piece));
}

function proxyToWorldHubWorkshop(req, res, defaultProto) {
  if (defaultProto !== 'https') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(308, { Location: ${JSON.stringify(origin)} + req.url, 'Cache-Control': 'no-store' });
      return res.end();
    }
    res.writeHead(426, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ error: 'HTTPS_REQUIRED' }));
  }
  const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
  const hop = new Set(hopHeaders);
  for (const name of String(req.headers.connection || '').split(',')) hop.add(name.trim().toLowerCase());
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!hop.has(key.toLowerCase()) && key.toLowerCase() !== 'forwarded' && !key.toLowerCase().startsWith('x-forwarded-')) headers[key] = value;
  }
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = ${JSON.stringify(new URL(origin).host)};
  headers['x-forwarded-for'] = req.socket.remoteAddress;
  const proxyReq = http.request({ hostname: '127.0.0.1', port: ${port}, path: req.url, method: req.method, headers }, proxyRes => {
    const outgoing = {};
    const responseHop = new Set(hopHeaders);
    for (const name of String(proxyRes.headers.connection || '').split(',')) responseHop.add(name.trim().toLowerCase());
    for (const [key, value] of Object.entries(proxyRes.headers)) if (!responseHop.has(key.toLowerCase())) outgoing[key] = value;
    res.writeHead(proxyRes.statusCode, outgoing);
    proxyRes.on('error', () => res.destroy());
    proxyRes.pipe(res);
  });
  proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error('Workshop proxy timeout')));
  proxyReq.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'WORKSHOP_UNAVAILABLE' }));
  });
  req.on('aborted', () => proxyReq.destroy());
  req.on('error', () => proxyReq.destroy());
  res.on('close', () => { if (!res.writableFinished) proxyReq.destroy(); });
  req.pipe(proxyReq);
}

`;
}

/** Prepare one fail-closed gateway edit; this function never reads or changes a server. */
export function createGatewayPatch(original, { expectedSha256, port = 8970, publicBaseUrl }) {
  if (!Buffer.isBuffer(original)) throw new TypeError('Gateway input must be the original file bytes.');
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 || '')) throw new Error('An exact expected gateway SHA-256 is required.');
  if (sha256(original) !== expectedSha256) throw new Error('Gateway changed since inspection; obtain and review a fresh copy.');
  const bom = original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const source = original.subarray(bom ? 3 : 0).toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(original.subarray(bom ? 3 : 0))) throw new Error('Gateway is not UTF-8; preserve its encoding manually.');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const insertion = gatewayInsertion(port, publicBaseUrl).replaceAll('\n', newline);
  const route = `  if (isWorldHubPrivateStaticPath(url.pathname)) {${newline}    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });${newline}    return res.end('Not found');${newline}  }${newline}  if (url.pathname === '/workshop' || url.pathname.startsWith('/workshop/')) {${newline}    return proxyToWorldHubWorkshop(req, res, defaultProto);${newline}  }${newline}${newline}`;
  if (source.includes(marker)) {
    if (!source.includes(insertion) || !source.includes(route)) throw new Error('An existing Workshop patch differs; review it rather than overwriting.');
    return { changed: false, beforeSha256: expectedSha256, afterSha256: expectedSha256, bytes: original, insertion, route };
  }
  if (source.split(anchor).length !== 2 || source.split(routeAnchor).length !== 2) throw new Error('Gateway layout changed; expected unique route anchors were not found.');
  if (source.indexOf(routeAnchor) < source.indexOf(anchor)) throw new Error('Unexpected gateway route order.');
  const updated = source.replace(anchor, insertion + anchor).replace(routeAnchor, route + routeAnchor);
  const bytes = Buffer.concat([bom ? original.subarray(0, 3) : Buffer.alloc(0), Buffer.from(updated, 'utf8')]);
  return { changed: true, beforeSha256: expectedSha256, afterSha256: sha256(bytes), bytes, insertion, route };
}

/** Generate a separate least-privilege Windows task. Applying it is a separate action. */
export function createWindowsTaskScript({ deploymentRoot, nodeExecutable, entry, taskName = 'WorldHubWorkshop' }) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(taskName)) throw new Error('Invalid task name.');
  for (const value of [deploymentRoot, nodeExecutable]) if (!/^[A-Za-z]:\\[^\r\n"%]+$/.test(value)) throw new Error('Use an explicit Windows path without quotes or control characters.');
  if (!/^[a-zA-Z0-9_./-]+\.mjs$/.test(entry) || entry.split(/[\\/]/).includes('..') || entry.startsWith('/')) throw new Error('entry must be a relative .mjs path below the deployed code root.');
  const q = psString;
  return `# Run on the target server only after code/config and the exact reviewed gateway patch are staged.
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath(${q(deploymentRoot)})
$taskNode = ${q(nodeExecutable)}
$taskEntry = Join-Path $taskRoot ${q('code/' + entry)}
$taskConfig = Join-Path $taskRoot 'config/workshop.json'
$taskName = ${q(taskName)}
if (-not (Test-Path -LiteralPath $taskNode -PathType Leaf)) { throw 'Node executable missing.' }
if (-not (Test-Path -LiteralPath $taskEntry -PathType Leaf)) { throw 'Workshop entry missing.' }
if (-not (Test-Path -LiteralPath $taskConfig -PathType Leaf)) { throw 'Workshop configuration missing.' }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Task already exists; review it before updating.' }
if (Get-NetTCPConnection -State Listen -LocalPort 8970 -ErrorAction SilentlyContinue) { throw 'Workshop loopback port is already occupied.' }
# Grant access only below this independent service root. Existing applications,
# their credentials, their tasks, and the shared Node executable are untouched.
& icacls.exe $taskRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to protect the service root.' }
foreach ($taskMutable in @('data', 'logs')) {
  $taskMutablePath = Join-Path $taskRoot $taskMutable
  New-Item -ItemType Directory -Path $taskMutablePath -Force | Out-Null
  & icacls.exe $taskMutablePath /grant:r '*S-1-5-19:(OI)(CI)M' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to grant the service access to its own data/logs.' }
}
$taskArguments = '--max-old-space-size=128 "' + $taskEntry + '" --config "' + $taskConfig + '"'
$taskAction = New-ScheduledTaskAction -Execute $taskNode -Argument $taskArguments -WorkingDirectory (Join-Path $taskRoot 'code')
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
$taskTrigger = New-ScheduledTaskTrigger -AtStartup
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Principal $taskPrincipal -Trigger $taskTrigger -Settings $taskSettings -Description 'Standalone World Hub Workshop; loopback only; stores and distributes artifacts without running modules.' | Out-Null
# Registration deliberately does not start the service or restart the gateway.
[pscustomobject]@{ task = $taskName; registered = $true; started = $false; root = $taskRoot } | ConvertTo-Json -Compress
`;
}

export async function prepareDeployment({ gatewayFile, expectedSha256, outputDirectory, deploymentRoot, nodeExecutable, entry, publicBaseUrl, port = 8970 }) {
  publicAddress(publicBaseUrl);
  if (port !== 8970) throw new Error('This reviewed Windows reference task uses loopback port 8970.');
  const output = resolve(outputDirectory);
  try { await lstat(output); throw new Error('Output already exists; choose a new private preparation directory.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const patch = createGatewayPatch(await readFile(gatewayFile), { expectedSha256, port, publicBaseUrl });
  const task = createWindowsTaskScript({ deploymentRoot, nodeExecutable, entry });
  await mkdir(output, { recursive: true, mode: 0o700 });
  const gatewayOutput = join(output, 'gateway-patched.private.js');
  await writeFile(gatewayOutput, patch.bytes, { flag: 'wx', mode: 0o600 });
  // Syntax-check without executing the gateway or loading its configuration.
  const check = spawnSync(process.execPath, ['--check', gatewayOutput], { encoding: 'utf8', windowsHide: true });
  if (check.status !== 0) {
    // Syntax diagnostics can quote credential-bearing lines from an existing
    // gateway. Keep them in the private preparation directory, never stdout.
    await writeFile(join(output, 'gateway-syntax.private.txt'), String(check.stderr || check.error?.message || 'Node syntax check failed'), { flag: 'wx', mode: 0o600 });
    throw new Error('Patched gateway syntax check failed; inspect the private preparation diagnostics.');
  }
  await writeFile(join(output, 'register-workshop-task.ps1'), task, { flag: 'wx', mode: 0o600 });
  await writeFile(join(output, 'gateway-additions.txt'), patch.insertion + patch.route, { flag: 'wx', mode: 0o600 });
  const plan = { format: 'world-hub.workshop-deployment-plan/v1', preparedAt: new Date().toISOString(), changed: patch.changed,
    gateway: { beforeSha256: patch.beforeSha256, afterSha256: patch.afterSha256, preparedFile: 'gateway-patched.private.js', syntaxChecked: true, closesPrivateStaticPaths: true },
    workshop: { deploymentRoot, nodeExecutable, entry, publicBaseUrl, host: '127.0.0.1', port, taskName: 'WorldHubWorkshop', taskPrincipal: 'LOCAL SERVICE', maxOldSpaceMiB: 128 },
    remoteActionsPerformed: false, requires: ['Review complete software/configuration manifest.', 'Back up gateway bytes and task XML on target.', 'Verify the original gateway SHA-256 again immediately before replacement.', 'Start and health-check only the new Workshop task.', 'Replace gateway atomically and restart only its verified task/PID.', 'Verify existing route status and roll back on regression.'] };
  await writeFile(join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = { '--gateway': 'gatewayFile', '--expected-sha256': 'expectedSha256', '--out': 'outputDirectory', '--root': 'deploymentRoot', '--node': 'nodeExecutable', '--entry': 'entry', '--public-base-url': 'publicBaseUrl' }[process.argv[i]];
    if (!key || !process.argv[i + 1] || options[key]) throw new Error('Expected --gateway, --expected-sha256, --out, --root, --node, --entry, --public-base-url.');
    options[key] = process.argv[i + 1];
  }
  for (const key of ['gatewayFile', 'expectedSha256', 'outputDirectory', 'deploymentRoot', 'nodeExecutable', 'entry', 'publicBaseUrl']) if (!options[key]) throw new Error('Missing ' + key);
  console.log(JSON.stringify(await prepareDeployment(options), null, 2));
}
