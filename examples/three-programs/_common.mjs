// 三个程序共用的一点点样板：建桥、带来源游标文件、自动 ACK。
//
// 这里没有任何"枢纽专属"的写法——桥就是普通客户端，程序自己的状态仍在自己的进程里。
import { resolve } from 'node:path';
import { Bridge, defaultCursorPath } from '../../sdk/javascript/bridge-kit.mjs';

export const HUB_URL = process.env.HUB_URL ?? 'ws://127.0.0.1:8801/bridge';

/** 一行一条 JSON 的程序日志，机器可断言、人也看得懂。 */
export function makeLog(program) {
  return (event, fields = {}) =>
    process.stdout.write(JSON.stringify({ at: new Date().toISOString(), program, event, ...fields }) + '\n');
}

/**
 * 建一座桥。
 *
 * bridgeId 必须等于 hub.config.json 里 acl.bridges 的键，否则会被拒。
 * cursorFile 保存已确认游标；重连仍可能重复投递，程序自己决定幂等策略。
 */
export function makeBridge(bridgeId, { role = 'both', displayName } = {}) {
  return new Bridge({
    bridgeId,
    url: HUB_URL,
    role,
    displayName: displayName ?? bridgeId,
    // HUB_CURSOR_FILE 让调用方（如 run-three.mjs）把游标定向到临时目录，
    // 避免在项目里留下 .hub/cursors。生产程序一般就直接用默认路径。
    cursorFile: process.env.HUB_CURSOR_FILE ?? resolve(defaultCursorPath(bridgeId)),
    // 默认行为：delivery 回调全部成功后自动 ACK；回调抛错就不 ACK，
    // 下次重连会重放这条。业务失败要不要重试，由程序自己决定。
  });
}

/** 程序正常退出：关桥、退进程。 */
export function installShutdown(bridge, log) {
  const stop = async (signal) => {
    log('bye', { signal: signal ?? 'SIGINT' });
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('程序通讯等待超时');
    await sleep(25);
  }
}
