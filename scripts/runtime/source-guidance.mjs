// Optional deployment diagnostics. Program types and application protocols are
// chosen outside Hub Core; these hints never execute or modify a source tree.
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ordinaryPath, readBounded, collectFiles } from './paths.mjs';

const guidance = {
  'external-program': [
    '此目录是普通程序源码，缺少本操作要求的 Runtime 声明。程序可以独立运行并通过模块桥连接 Hub，无需先导入 Launcher。若要由可选 Runtime 托管，请由作者按其部署规范适配；Electron 等原生宿主的安装、窗口和子进程仍由程序负责。',
    'This is a program source directory without the Runtime declaration required by this operation. Run it independently and connect through a module bridge, or have its author adapt it to the optional Runtime deployment profile. Native hosts such as Electron own their installation, windows and child processes.'
  ],
  'module-source': [
    '此目录包含 module.json，是模块源码。导入实例需要包含 pack.json 和 pack.lock 的整合包；请在创作工作台中选择它作为模块候选，或由作者创建整合包。独立程序也可自行运行并连接 Hub。',
    'This directory contains module.json and is a module source. Instance import requires a pack with pack.json and pack.lock. Select this source as a module candidate in Creator or create a pack. An independent program can also run itself and connect to the Hub.'
  ],
  'pack-source': [
    '此目录包含 pack.json，是整合包根目录。模块候选应选择其中声明的模块源码目录，而导入实例应选择此整合包根目录。',
    'This is a pack root containing pack.json. Select a declared module source directory as a module candidate; select this pack root when importing an instance.'
  ],
  'deployment-source-limit': [
    '目录超过可选 Runtime v1 的源码分发限制（每文件 8 MiB、合计 64 MiB、4096 个文件）。已安装的 node_modules 或本机运行时可能不适合直接打包；请由作者准备完整且符合限制的分发源码，或让该程序独立安装运行并通过模块桥连接 Hub。此限制不限制 Hub 接入的程序形态，也不证明沙箱隔离。',
    'The directory exceeds the optional Runtime v1 source-distribution limits (8 MiB per file, 64 MiB total, 4096 files). Installed node_modules or native runtimes may be unsuitable for direct packaging. Prepare a complete distribution within that profile, or install and run the program independently through a module bridge. These limits do not restrict program shapes accepted by the Hub or establish sandbox isolation.'
  ]
};

async function regularMarker(root, name) {
  try { await ordinaryPath(join(root, name)); return (await lstat(join(root, name))).isFile(); }
  catch { return false; } // Supplemental hints never replace the original error.
}

export async function attachSourceGuidance(error, directory, expected = 'module') {
  let kind;
  try {
    const root = await ordinaryPath(directory);
    const [module, pack, nodeProgram] = await Promise.all([
      regularMarker(root, 'module.json'), regularMarker(root, 'pack.json'), regularMarker(root, 'package.json')
    ]);
    if (error.code === 'MODULE_SOURCE_LIMIT') kind = 'deployment-source-limit';
    else if (expected === 'pack' && !pack && module) kind = 'module-source';
    else if (expected === 'module' && !module && pack) kind = 'pack-source';
    else if (!(expected === 'pack' ? pack : module) && nodeProgram) kind = 'external-program';
  } catch { /* An invalid root keeps its original path diagnostic. */ }
  if (kind) error.diagnostic = { code: error.code ?? 'SOURCE_PROFILE_REQUIRED', kind,
    zh: guidance[kind][0], en: guidance[kind][1] };
  return error;
}

export async function readSourceManifest(directory, name) {
  try { return await readBounded(join(directory, name)); }
  catch (error) { throw await attachSourceGuidance(error, directory, name === 'pack.json' ? 'pack' : 'module'); }
}

export async function collectSourceFiles(directory) {
  try { return await collectFiles(directory); }
  catch (error) { throw await attachSourceGuidance(error, directory); }
}
