#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { verifyTextStatistics } from '../tools/interop/text-statistics.mjs';
import { readBounded } from '../scripts/runtime/paths.mjs';

const help = `World Hub optional application-contract verification
  world-hub-interop verify --config private-wiring.json --report new-report.json
  world-hub-interop --help

Profile: text.statistics@1.0.0. Read docs/ecosystem/interop.md.
Uses public bridge messages; never starts programs, installs code or grants execution authority.
Reports declaration, protocol and business separately. Full pass requires a module declaration and deniedCaller.
Fault-injection lifecycle cases are a separate controlled reference suite: npm run test:interop (repository).
`;
try {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0])) process.stdout.write(help);
  else {
    if (args.length !== 5 || args[0] !== 'verify' || args[1] !== '--config' || args[3] !== '--report') throw new Error('Use --help');
    const config = JSON.parse((await readBounded(args[2], 65536)).toString());
    const report = await verifyTextStatistics(config);
    await writeFile(args[4], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ passed: report.passed, report: args[4], layers: Object.fromEntries(Object.entries(report.layers).map(([k, v]) => [k, v.status])) }));
    if (!report.passed) process.exitCode = 1;
  }
} catch (error) { console.error(JSON.stringify({ code: error.code ?? 'VERIFICATION_FAILED' })); process.exitCode = 1; }
