#!/usr/bin/env node
// npm entry: configuration and persistence belong to the invoking workspace.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLauncher } from '../scripts/launcher.mjs';
import { checkEnvironment, parseArgs } from '../scripts/launcher-support.mjs';
import { normalizeConfig } from '../src/hub/lib/store.mjs';

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HELP = `世界枢纽 npm 命令（前台运行）

  world-hub [--config <path>] [--data-dir <path>] [--port <n>] [--open]
  world-hub --check [--config <path>] [--data-dir <path>] [--port <n>]

  --config, -c <path>  使用自己的配置；相对路径以当前工作目录为基准
  --data-dir <path>    明确指定通讯日志、大对象与管理状态的数据根
  --port, -p <n>       本次覆盖监听端口；0 至 65535，0 为系统分配
  --check             只读检查；不会创建配置、数据或运行锁，也不启动服务
  --open              就绪后打开本机管理界面
  --help, -h          显示帮助

未指定配置时，首次启动会在当前目录 world-hub-data/hub.json 写入参考配置，
默认数据也在 world-hub-data 内。已存在的配置会继续使用，不会被模板覆盖。
指定 --data-dir 时三类数据都放在该根；原 --config 文件保持不变。
安装目录不保存运行配置和数据。启动后使用 Ctrl+C 等待 stopped 行再关闭终端。
枢纽只提供通讯；外部程序由自己的 mod 桥接入。
`;

export function parseNpmArgs(argv) {
  const launcherArgs = [];
  let dataDir = null, explicitConfig = false;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === '--data-dir') {
      if (dataDir !== null) throw new Error('参数重复：--data-dir');
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new Error('--data-dir 缺少值');
      dataDir = value;
    } else {
      launcherArgs.push(option);
      if (option === '--config' || option === '-c') explicitConfig = true;
    }
  }
  return { ...parseArgs(launcherArgs), dataDir, explicitConfig };
}

async function readOptionalJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function planNpmInvocation(args, { cwd = process.cwd(), packageRoot = PACKAGE_ROOT } = {}) {
  const dataRoot = resolve(cwd, args.dataDir ?? 'world-hub-data');
  const defaultConfigPath = join(dataRoot, 'hub.json');
  const sourceConfigPath = args.explicitConfig ? resolve(cwd, args.config) : defaultConfigPath;
  let raw = args.explicitConfig
    ? JSON.parse(await readFile(sourceConfigPath, 'utf8'))
    : await readOptionalJson(sourceConfigPath);
  const sourceExists = raw !== undefined;
  if (!sourceExists) {
    raw = JSON.parse(await readFile(join(packageRoot, 'config/hub.json'), 'utf8'));
    raw.log = { ...raw.log, dir: './log' };
    raw.blobs = { ...raw.blobs, dir: './blobs' };
    raw.management = { ...raw.management, stateFile: './management.json' };
  }
  // Reject an invalid source before the explicit storage override can replace
  // malformed log/blobs/management fields with otherwise valid path settings.
  normalizeConfig(raw, sourceConfigPath);
  let configPath = sourceConfigPath, materialize = !sourceExists;
  if (args.dataDir !== null) {
    // This is the only explicit override of a supplied configuration's storage.
    raw = structuredClone(raw);
    raw.log = { ...raw.log, dir: join(dataRoot, 'log') };
    raw.blobs = { ...raw.blobs, dir: join(dataRoot, 'blobs') };
    raw.management = { ...raw.management, stateFile: join(dataRoot, 'management.json') };
    if (sourceExists) {
      const digest = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
      configPath = join(dataRoot, 'configs', `hub-${digest}.json`);
      materialize = true;
    }
  }
  const checked = await checkEnvironment(packageRoot, args, { rawConfig: raw, configPath });
  return { configPath, sourceConfigPath, raw, materialize, checked: { ...checked, configSource: sourceExists ? sourceConfigPath : 'packaged-reference',
    configExists: !materialize, wouldCreateConfig: materialize, defaultDataRoot: dataRoot } };
}

export async function runNpmCli(argv = process.argv.slice(2), options = {}) {
  const args = parseNpmArgs(argv);
  if (args.help) { process.stdout.write(HELP); return; }
  const plan = await planNpmInvocation(args, options);
  if (args.check) { process.stdout.write(JSON.stringify(plan.checked, null, 2) + '\n'); return; }
  if (plan.materialize) {
    await mkdir(dirname(plan.configPath), { recursive: true });
    const bytes = JSON.stringify(plan.raw, null, 2) + '\n';
    try { await writeFile(plan.configPath, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await readFile(plan.configPath, 'utf8') !== bytes) throw new Error(`配置已在检查后改变，未覆盖：${plan.configPath}`);
    }
  }
  const launcherArgs = ['--config', plan.configPath];
  if (args.port !== null) launcherArgs.push('--port', String(args.port));
  if (args.open) launcherArgs.push('--open');
  return runLauncher(launcherArgs, { bundleRoot: options.packageRoot ?? PACKAGE_ROOT });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNpmCli().catch(error => {
    process.stderr.write(`世界枢纽启动失败：${error.message}\n`);
    if (process.connected && typeof process.send === 'function') {
      try { process.send({ type: 'error', message: error.message, code: error.code ?? 'NPM_START_FAILED' }, () => {}); } catch {}
      process.disconnect();
    }
    process.exitCode = 2;
  });
}
