// Optional external deployment adapter. Hub Core neither selects this profile
// nor grants files/network/process access. No provider means no local fallback.
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises';
import { isAbsolute, join, dirname, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ownProcess } from './process.mjs';
import { filteredEnv } from './package.mjs';
import { ordinaryPath, collectFiles, hash, relativePath, readBounded } from './paths.mjs';
import { ISOLATION_EVENT, channelChunks, collectChannelChunk } from './isolation-channel.mjs';

const execute = promisify(execFile), here = dirname(fileURLToPath(import.meta.url));
const failure = (code, message) => Object.assign(new Error(message), { code });
const localEndpoint = value => typeof value === 'string' && (value === 'npipe:////./pipe/dockerDesktopLinuxEngine' || value === 'npipe:////./pipe/docker_engine' || /^unix:\/\/\/[^\0\r\n]+$/.test(value));
const imagePattern = /^[a-z0-9][a-z0-9./:_-]{0,200}@sha256:[a-f0-9]{64}$/;
const bounds = { memoryMiB: [64, 4096], pids: [16, 256], cpus: [.1, 4], user: [1, 65535] };
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const contains = (parent, child) => !relative(parent, child).startsWith('..') && !isAbsolute(relative(parent, child));
async function within(promise, milliseconds, fallback) {
  let timer; try { return await Promise.race([promise, new Promise((resolveWait, reject) => { timer = setTimeout(() => fallback instanceof Error ? reject(fallback) : resolveWait(fallback), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function provider(options) {
  if (!isAbsolute(options.dockerPath ?? '') || !localEndpoint(options.endpoint)) throw failure('ISOLATION_PROVIDER_INVALID', 'An absolute Docker executable and a local Linux daemon endpoint are required');
  const executable = await ordinaryPath(options.dockerPath);
  if (!(await lstat(executable)).isFile()) throw failure('ISOLATION_PROVIDER_INVALID', 'Docker executable must be an ordinary file');
  return { executable, executableSha256: hash(await readFile(executable)), endpoint: options.endpoint };
}
async function docker(p, argv, { timeout = 15000, maxBuffer = 1024 * 1024 } = {}) {
  return execute(p.executable, ['--host', p.endpoint, ...argv], { windowsHide: true, shell: false, timeout, maxBuffer, encoding: 'utf8', env: filteredEnv(p.executable) });
}
export async function probeIsolation(options = {}) {
  const result = { format: 'world-hub.isolation-probe/v1', provider: 'docker-linux', available: false, startsContainers: false, installsProvider: false, observedAt: new Date().toISOString() };
  try {
    const p = await provider(options); result.executable = p.executable; result.executableSha256 = p.executableSha256; result.endpoint = p.endpoint;
    const info = JSON.parse((await docker(p, ['info', '--format', '{{json .}}'], { timeout: 10000 })).stdout);
    if (info.OSType !== 'linux' || !['x86_64', 'aarch64', 'amd64', 'arm64'].includes(info.Architecture)) throw failure('ISOLATION_PROVIDER_UNSUPPORTED', 'Only Linux amd64/arm64 engines are supported');
    if (!(info.SecurityOptions ?? []).some(x => x.includes('seccomp')) || info.PidsLimit === false || info.MemoryLimit === false || info.CPUShares === false) throw failure('ISOLATION_PROVIDER_UNSUPPORTED', 'The Linux daemon must enforce seccomp, PID and memory limits');
    Object.assign(result, { available: true, serverVersion: info.ServerVersion, architecture: info.Architecture, os: info.OSType, cgroupVersion: info.CgroupVersion, securityOptions: info.SecurityOptions });
  } catch (error) { result.error = { code: error.code?.startsWith?.('ISOLATION_') ? error.code : 'ISOLATION_PROVIDER_UNAVAILABLE', message: 'Isolation provider is unavailable or does not meet the fixed Linux profile; no program was started', remedy: 'Start an already configured local Docker Linux daemon, select its executable/endpoint, and probe again.' }; }
  return result;
}
export async function reviewIsolationPackage(plan, options = {}) {
  if (!plan?.digest || !Array.isArray(plan.modules)) throw failure('ISOLATION_REVIEW_REQUIRED', 'Inspect a locked package first');
  if (Object.keys(options).some(key => !['dockerPath', 'endpoint', 'image', 'architecture', 'limits'].includes(key))) throw failure('ISOLATION_PROFILE_INVALID', 'Unknown isolation policy field');
  for (const module of plan.modules) {
    if (module.manifest.runtime.kind !== 'node' || module.manifest.permissions.processes !== 'none' || module.manifest.permissions.network.some(kind => kind !== 'hub-loopback'))
      throw failure('ISOLATION_RUNTIME_UNSUPPORTED', 'The fixed profile accepts Node headless modules with no declared child processes and only Hub communication');
  }
  if (!imagePattern.test(options.image ?? '')) throw failure('ISOLATION_IMAGE_UNPINNED', 'An explicit repository@sha256 image is required');
  const p = await provider(options), probe = await probeIsolation(options);
  if (!probe.available) throw failure(probe.error.code, probe.error.message);
  const architecture = options.architecture ?? (process.arch === 'arm64' ? 'arm64' : 'amd64');
  const seccomp = isolationSeccomp(architecture), limits = { memoryMiB: 256, pids: 64, cpus: 1, user: process.platform !== 'win32' && process.getuid?.() > 0 ? process.getuid() : 1000, ...options.limits };
  if (Object.keys(limits).some(key => !Object.hasOwn(bounds, key))) throw failure('ISOLATION_LIMITS_INVALID', 'Unknown resource limit');
  for (const [key, value] of Object.entries(limits)) if (!Number.isFinite(value) || value < bounds[key][0] || value > bounds[key][1] || key !== 'cpus' && !Number.isInteger(value)) throw failure('ISOLATION_LIMITS_INVALID', `Invalid ${key}`);
  const image = JSON.parse((await docker(p, ['image', 'inspect', options.image])).stdout)[0];
  if (image.Os !== 'linux' || image.Architecture !== architecture || !(image.RepoDigests ?? []).some(value => value.endsWith('@' + options.image.split('@')[1]))) throw failure('ISOLATION_IMAGE_MISMATCH', 'Select an already available matching Linux image; no image is pulled automatically');
  const adapterHashes = Object.fromEntries(await Promise.all(['isolation-wrapper.mjs', 'isolation-channel.mjs', '../../src/hub/ws-server.mjs'].map(async file => [file, hash(await readBounded(join(here, file)))])));
  const review = { format: 'world-hub.isolation-review/v1', profile: 'docker-node-headless/v1', packageDigest: plan.digest, provider: p, image: options.image,
    imageId: image.Id, architecture, limits, expectedNodeVersion: plan.environment.node.version, adapterHashes, seccompSha256: hash(JSON.stringify(seccomp)),
    components: plan.pack.components.map(component => component.id), network: 'none', communication: 'stdio-to-own-instance-hub-only', startsPrograms: false, sandbox: false,
    policy: { dockerPath: p.executable, endpoint: p.endpoint, image: options.image, architecture, limits } };
  review.digest = hash(JSON.stringify(review)); return review;
}

// Deliberate allowlist rather than pretending PID quota forbids subprocesses.
// clone is permitted only with CLONE_THREAD; fork/vfork are absent. clone3
// returns ENOSYS so current glibc falls back to the filtered clone syscall.
export function isolationSeccomp(architecture = 'amd64') {
  if (!['amd64', 'arm64'].includes(architecture)) throw failure('ISOLATION_ARCH_UNSUPPORTED', 'Unsupported seccomp architecture');
  const calls = ('accept accept4 access arch_prctl bind brk capget chdir chmod clock_getres clock_gettime clock_nanosleep close close_range connect copy_file_range dup dup2 dup3 epoll_create epoll_create1 epoll_ctl epoll_pwait epoll_pwait2 epoll_wait eventfd eventfd2 execve execveat exit exit_group faccessat faccessat2 fadvise64 fallocate fchdir fchmod fchmodat fcntl fdatasync flock fstat fstatfs fsync ftruncate futex futex_waitv getcpu getcwd getdents getdents64 getegid geteuid getgid getgroups getitimer getpeername getpgid getpgrp getpid getppid getpriority getrandom getresgid getresuid getrlimit get_robust_list getrusage getsid getsockname getsockopt gettid gettimeofday getuid getxattr inotify_add_watch inotify_init inotify_init1 inotify_rm_watch ioctl kill lgetxattr link linkat listxattr llistxattr listen lseek lstat madvise membarrier memfd_create mincore mkdir mkdirat mlock mlock2 mlockall mmap mprotect mremap msync munlock munlockall munmap nanosleep newfstatat open openat openat2 pause pipe pipe2 poll ppoll prctl pread64 preadv preadv2 prlimit64 pselect6 pwrite64 pwritev pwritev2 read readahead readlink readlinkat readv recvfrom recvmmsg recvmsg rename renameat renameat2 restart_syscall rmdir rseq rt_sigaction rt_sigpending rt_sigprocmask rt_sigqueueinfo rt_sigreturn rt_sigsuspend rt_sigtimedwait rt_tgsigqueueinfo sched_getaffinity sched_getattr sched_getparam sched_get_priority_max sched_get_priority_min sched_getscheduler sched_setaffinity sched_yield select sendfile sendmmsg sendmsg sendto setitimer setpgid setpriority setrlimit set_robust_list setsid setsockopt set_tid_address shutdown sigaltstack signalfd signalfd4 socket socketpair splice stat statfs statx symlink symlinkat sync sync_file_range syncfs sysinfo tee tgkill time timer_create timer_delete timer_getoverrun timer_gettime timer_settime timerfd_create timerfd_gettime timerfd_settime times truncate umask uname unlink unlinkat utime utimensat utimes wait4 waitid write writev').split(' ');
  return { defaultAction: 'SCMP_ACT_ERRNO', defaultErrnoRet: 1, architectures: [architecture === 'amd64' ? 'SCMP_ARCH_X86_64' : 'SCMP_ARCH_AARCH64'], syscalls: [
    { names: calls, action: 'SCMP_ACT_ALLOW' },
    { names: ['clone'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value: 65536, valueTwo: 65536, op: 'SCMP_CMP_MASKED_EQ' }] },
    { names: ['clone3'], action: 'SCMP_ACT_ERRNO', errnoRet: 38 },
  ] };
}

export async function planIsolation(options = {}) {
  const p = await provider(options);
  if (!imagePattern.test(options.image ?? '')) throw failure('ISOLATION_IMAGE_UNPINNED', 'An explicit repository@sha256 image is required; tags are not executable reviews');
  if (options.runtime !== undefined && options.runtime !== 'node') throw failure('ISOLATION_RUNTIME_UNSUPPORTED', 'The docker-node-headless/v1 profile supports Node modules only');
  if (options.network !== undefined && options.network !== 'none' || options.entryUrl !== undefined) throw failure('ISOLATION_NETWORK_UNSUPPORTED', 'This profile has no network interface and no UI HTTP tunnel; it cannot expose an entry URL');
  const limits = { memoryMiB: 256, pids: 64, cpus: 1, user: process.platform !== 'win32' && process.getuid?.() > 0 ? process.getuid() : 1000, ...options.limits };
  if (Object.keys(limits).some(k => !Object.hasOwn(bounds, k))) throw failure('ISOLATION_LIMITS_INVALID', 'Unknown isolation resource limit');
  for (const [name, value] of Object.entries(limits)) if (!Number.isFinite(value) || value < bounds[name][0] || value > bounds[name][1] || name !== 'cpus' && !Number.isInteger(value)) throw failure('ISOLATION_LIMITS_INVALID', `Invalid ${name}`);
  const source = await ordinaryPath(options.sourceDirectory), state = await ordinaryPath(options.stateDirectory), config = await ordinaryPath(options.configPath);
  const adapter = await ordinaryPath(options.adapterDirectory, { allowMissing: true });
  for (const path of [source, state, config, adapter]) if (/[\r\n,]/.test(path)) throw failure('ISOLATION_MOUNT_INVALID', 'Mount paths cannot contain Docker mount delimiters');
  if (contains(source, state) || contains(state, source) || contains(source, adapter) || contains(state, adapter)) throw failure('ISOLATION_MOUNT_OVERLAP', 'Source, component state and private adapter must not overlap');
  const entry = relativePath(options.entry), files = await collectFiles(source);
  if (!files.some(file => file.path === entry)) throw failure('ISOLATION_ENTRY_INVALID', 'The isolated module entry must belong to its reviewed source');
  const configuration = JSON.parse((await readBounded(config)).toString('utf8'));
  if (configuration.format !== 'world-hub.run/v1' || !Array.isArray(configuration.bridges) || configuration.bridges.length < 1 || configuration.bridges.length > 8) throw failure('ISOLATION_CONFIG_INVALID', 'A per-component Runtime configuration with 1..8 bridges is required');
  const endpoints = new Set(configuration.bridges.map(bridge => bridge.endpoint));
  for (const endpoint of endpoints) { const url = new URL(endpoint); if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/bridge' || url.username || url.password || url.search || url.hash) throw failure('ISOLATION_DESTINATION_INVALID', 'The broker can contact only an explicit local instance Hub /bridge endpoint'); }
  if (endpoints.size !== 1) throw failure('ISOLATION_DESTINATION_INVALID', 'All component bridges must target the same instance Hub');
  const architecture = options.architecture ?? (process.arch === 'arm64' ? 'arm64' : 'amd64');
  const seccomp = isolationSeccomp(architecture);
  const adapterFiles = ['isolation-wrapper.mjs', 'isolation-channel.mjs'];
  const adapterHashes = Object.fromEntries(await Promise.all(adapterFiles.map(async file => [file, hash(await readBounded(join(here, file)))])));
  adapterHashes['ws-server.mjs'] = hash(await readBounded(join(here, '../../src/hub/ws-server.mjs')));
  const value = { format: 'world-hub.isolation-plan/v1', profile: 'docker-node-headless/v1', provider: p, image: options.image,
    architecture, entry, source, state, config, adapter, files, configSha256: hash(await readBounded(config)), adapterHashes, seccompSha256: hash(JSON.stringify(seccomp)),
    limits, network: 'none', filesystem: { source: 'read-only', componentState: 'read-write', otherHostFiles: 'not-mounted', root: 'read-only', temporary: '64MiB-tmpfs' },
    processes: 'no-new-child-processes; Node threads allowed and PID-limited', communication: 'stdio-to-own-instance-hub-only', startsPrograms: false, sandbox: false };
  value.digest = hash(JSON.stringify(value));
  return value;
}

export async function ownIsolatedProcess(plan, { trust, temporary, secrets, onFailure, onEvent, signal } = {}) {
  if (!plan || plan.format !== 'world-hub.isolation-plan/v1' || trust !== plan.digest) throw failure('ISOLATION_REVIEW_REQUIRED', 'The current executable/image/mount/network isolation plan must be explicitly reviewed');
  const checked = await planIsolation({ dockerPath: plan.provider.executable, endpoint: plan.provider.endpoint, image: plan.image, architecture: plan.architecture, entry: plan.entry, sourceDirectory: plan.source, stateDirectory: plan.state, configPath: plan.config, adapterDirectory: plan.adapter, limits: plan.limits });
  if (checked.digest !== plan.digest) throw failure('ISOLATION_REVIEW_CHANGED', 'Isolation code, executable, configuration or source changed after review');
  const probe = await probeIsolation({ dockerPath: plan.provider.executable, endpoint: plan.provider.endpoint });
  if (!probe.available) throw failure(probe.error.code, probe.error.message);
  const image = JSON.parse((await docker(plan.provider, ['image', 'inspect', plan.image])).stdout)[0];
  if (image.Os !== 'linux' || image.Architecture !== plan.architecture || !(image.RepoDigests ?? []).some(value => value.endsWith('@' + plan.image.split('@')[1]))) throw failure('ISOLATION_IMAGE_MISMATCH', 'The already available image must match its reviewed Linux architecture and digest; images are not pulled automatically');
  await mkdir(plan.adapter, { mode: 0o700 });
  await mkdir(join(plan.adapter, 'scripts/runtime'), { recursive: true }); await mkdir(join(plan.adapter, 'src/hub'), { recursive: true });
  for (const file of ['isolation-wrapper.mjs', 'isolation-channel.mjs']) await copyFile(join(here, file), join(plan.adapter, 'scripts/runtime', file));
  await copyFile(join(here, '../../src/hub/ws-server.mjs'), join(plan.adapter, 'src/hub/ws-server.mjs'));
  const seccompPath = join(plan.adapter, 'seccomp.json'); await writeFile(seccompPath, JSON.stringify(isolationSeccomp(plan.architecture)));
  const owner = randomUUID(), name = 'world-hub-' + owner;
  const mounts = [[plan.source, '/source', true], [plan.state, '/state', false], [plan.config, '/configuration.json', true], [plan.adapter, '/adapter', true]];
  const argv = ['create', '--name', name, '--label', 'world-hub.owner=' + owner, '--pull', 'never', '--interactive', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--security-opt', 'seccomp=' + seccompPath,
    '--user', String(plan.limits.user), '--pids-limit', String(plan.limits.pids), '--memory', plan.limits.memoryMiB + 'm', '--memory-swap', plan.limits.memoryMiB + 'm', '--cpus', String(plan.limits.cpus), '--ipc', 'none', '--no-healthcheck', '--log-driver', 'none',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777', '--workdir', '/state', '--entrypoint', '/usr/local/bin/node'];
  for (const [source, target, readonly] of mounts) argv.push('--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`);
  argv.push(plan.image, '/adapter/scripts/runtime/isolation-wrapper.mjs', '/source/' + plan.entry, '/configuration.json');
  let cid, h, cleanup = null; const channels = new Map();
  const inspectOwned = async () => {
    const container = JSON.parse((await docker(plan.provider, ['inspect', cid])).stdout)[0];
    if (container.Id !== cid || container.Config.Labels?.['world-hub.owner'] !== owner) throw failure('ISOLATION_OWNER_CHANGED', 'Container ownership changed; no foreign container was controlled');
    return container;
  };
  const clean = () => cleanup ??= (async () => { for (const c of channels.values()) c.ws?.close(); channels.clear(); if (cid) { await inspectOwned(); await docker(plan.provider, ['rm', '--force', cid]); } })().catch(error => { cleanup = null; throw error; });
  try {
    cid = (await docker(plan.provider, argv)).stdout.trim(); if (!/^[a-f0-9]{64}$/.test(cid)) throw failure('ISOLATION_CONTAINER_INVALID', 'Docker did not return a complete container identity');
    const actual = await inspectOwned(), config = actual.HostConfig;
    const actualMounts = actual.Mounts.filter(mount => mount.Type === 'bind');
    const seccompOption = config.SecurityOpt?.find(value => value.startsWith('seccomp='));
    const hostSource = value => process.platform === 'win32' ? value.replace(/^\/(?:host_mnt|run\/desktop\/mnt\/host)\/([a-z])\//i, (_, drive) => drive.toUpperCase() + ':\\').replace(/\//g, '\\') : value;
    let seccompMatches = false; try { seccompMatches = isDeepStrictEqual(JSON.parse(seccompOption?.slice(8)), isolationSeccomp(plan.architecture)); } catch { /* Unrecognized provider security profile fails closed. */ }
    const audited = config.NetworkMode === 'none' && config.ReadonlyRootfs === true && config.Privileged === false && config.CapDrop?.some(value => value.toUpperCase() === 'ALL')
      && actual.Config.User === String(plan.limits.user) && config.PidsLimit === plan.limits.pids && config.Memory === plan.limits.memoryMiB * 1024 * 1024 && config.MemorySwap === config.Memory
      && config.NanoCpus === plan.limits.cpus * 1e9 && config.SecurityOpt?.includes('no-new-privileges=true') && seccompMatches
      && config.IpcMode === 'none' && config.LogConfig.Type === 'none' && !Object.keys(config.PortBindings ?? {}).length && config.Tmpfs?.['/tmp'] === 'rw,noexec,nosuid,nodev,size=67108864,mode=1777'
      && actualMounts.length === mounts.length && actual.Mounts.every(mount => mount.Type === 'bind' || mount.Type === 'tmpfs' && mount.Destination === '/tmp')
      && mounts.every(([source, target, readonly]) => actualMounts.some(mount => same(hostSource(mount.Source), source) && mount.Destination === target && mount.RW === !readonly));
    if (!audited) throw failure('ISOLATION_AUDIT_FAILED', 'The created container does not match the reviewed confinement; its entry was never started');
    const configuration = JSON.parse((await readBounded(plan.config)).toString('utf8')), endpoint = configuration.bridges[0].endpoint;
    const receive = frame => {
      if (frame.event !== ISOLATION_EVENT) { onEvent?.(frame); return; }
      try {
        if (typeof frame.connection !== 'string' || !/^[a-f0-9-]{36}$/.test(frame.connection)) throw new Error('Invalid isolation connection');
        if (frame.operation === 'open') {
          if (channels.has(frame.connection) || channels.size >= configuration.bridges.length) throw new Error('Isolation connection limit');
          channels.set(frame.connection, { pending: null, ws: null, first: true }); return;
        }
        const connection = channels.get(frame.connection); if (!connection) throw new Error('Unknown isolation connection');
        if (frame.operation === 'close') { connection.ws?.close(); channels.delete(frame.connection); return; }
        const result = collectChannelChunk(connection.pending, frame); connection.pending = result.pending;
        if (result.text === null) return;
        if (connection.first) {
          const hello = JSON.parse(result.text);
          if (hello.type !== 'hello' || !configuration.bridges.some(bridge => bridge.bridgeId === hello.bridge && bridge.credential === hello.credential && bridge.token === hello.token)) throw new Error('Isolation bridge identity is not owned by this component');
          connection.first = false; const ws = new WebSocket(endpoint); connection.ws = ws;
          ws.addEventListener('open', () => { if (channels.get(frame.connection) === connection) ws.send(result.text); });
          ws.addEventListener('message', event => { try { for (const chunk of channelChunks(frame.connection, event.data)) h.send(chunk); } catch (error) { onFailure?.(error); } });
          const close = () => { if (channels.get(frame.connection) !== connection) return; channels.delete(frame.connection); h.send({ event: ISOLATION_EVENT, operation: 'close', connection: frame.connection }); };
          ws.addEventListener('close', close); ws.addEventListener('error', close);
        } else {
          if (connection.ws.readyState !== WebSocket.OPEN || connection.ws.bufferedAmount > 8 * 1024 * 1024) throw new Error('Isolation channel is not ready or exceeds backpressure bound');
          connection.ws.send(result.text);
        }
      } catch (error) { onFailure?.(failure('ISOLATION_CHANNEL_REJECTED', error.message)); }
    };
    h = ownProcess(plan.provider.executable, ['--host', plan.provider.endpoint, 'start', '--attach', '--interactive', cid], { cwd: plan.state, temporary, secrets, onFailure, onEvent: frame => {
      if (frame.event === 'isolation-ready') { h.messages.push(frame); if (h.messages.length > 128) h.messages.shift(); }
      receive(frame);
    }, signal });
    h.isolation = { profile: plan.profile, sandbox: true, containerId: cid, reviewDigest: plan.digest, image: plan.image, auditedBeforeStart: true, network: 'none', processes: plan.processes };
    h.stop = async timeoutMs => {
      if (cleanup) { await cleanup; return h.exit; }
      h.stopping = true; h.send({ command: 'stop' });
      const finished = await within(h.closed.then(() => true), timeoutMs, false);
      if (!finished) { h.forced = true; const owned = await inspectOwned(); if (owned.State.Running) await docker(plan.provider, ['kill', cid]); }
      await within(h.closed, 10000, failure('ISOLATION_CLEANUP_INCOMPLETE', 'Container attach exit was not confirmed'));
      const owned = await inspectOwned(); if (owned.State.Running) { await docker(plan.provider, ['kill', cid]); if ((await inspectOwned()).State.Running) throw failure('ISOLATION_CLEANUP_INCOMPLETE', 'Owned container still runs; supervisor ownership retained'); }
      await clean(); return h.exit;
    };
    return h;
  } catch (error) { try { await clean(); } catch (cleanupError) { error.cleanupError = cleanupError.message; } throw error; }
}
