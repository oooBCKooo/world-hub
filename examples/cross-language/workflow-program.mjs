// Application fixture: chooses every round itself, outside the Hub.
import { Bridge } from '../../sdk/javascript/bridge-kit.mjs';
import { randomUUID } from 'node:crypto';
const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].replace(/^--/, ''), process.argv[3 + i * 2]]));
const bridge = new Bridge({ url: args.url, bridgeId: 'phase7.workflow', token: args.token, autoAck: false });
const runId = randomUUID();
const trace = [], started = Date.now();
const deadline = setTimeout(() => { console.error('workflow deadline exceeded'); process.exit(1); }, 20000);
bridge.on('error', (error) => console.error(JSON.stringify(error)));
try {
  await bridge.connect();
  if (!bridge.welcome.features.includes('directed-v1')) throw new Error('directed-v1 required');
  let result = { fixture: 'phase7', runId, steps: ['javascript'], payload: { 系统提示词: '来自分布程序的测试上下文 🌍', 对话: [{ role: 'user', content: '请跨语言转交' }] } };
  // Three rounds, two programs in each round. The programs append their own steps.
  for (let round = 1; round <= 3; round++) {
    const branches = await Promise.all(['python', 'powershell'].map(async (language) => {
      const { request, response } = await bridge.call({ principal: `phase7.${language}.service` }, 'phase7/workflow', result, { correlation: `${runId}/${round}/${language}`, timeoutMs: 8000 });
      if (response.fromPrincipal !== `phase7.${language}.service` || response.requestSeq !== request.seq || response.body.runId !== runId || response.body.steps.at(-1) !== language) throw new Error('untrusted or unmatched workflow result');
      trace.push({ round, language, requestSeq: request.seq, responseSeq: response.seq, steps: response.body.steps });
      bridge.ack(response);
      return response.body;
    }));
    result = { ...result, steps: [...result.steps, ...branches.map((body) => body.steps.at(-1)), `javascript:round-${round}`] };
  }
  console.log(JSON.stringify({ event: 'result', pid: process.pid, runId, rounds: 3, programsPerRound: 2, result, trace, elapsedMs: Date.now() - started }));
} catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
finally { clearTimeout(deadline); await bridge.close(); }
