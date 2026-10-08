import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

// Each execution owns a new directory; latest.json is only a mutable index.
export async function reserveEvidenceRun(base) {
  const baseDirectory = resolve(base), runs = join(baseDirectory, 'runs');
  await mkdir(runs, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = await mkdtemp(join(runs, `${stamp}-`));
  return { baseDirectory, directory };
}

export async function saveLatestEvidence(run, report) {
  const destination = join(run.baseDirectory, 'latest.json');
  const temporary = join(run.baseDirectory, `.latest-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({
      recordedAt: new Date().toISOString(), passed: report.passed, version: report.version,
      report: relative(run.baseDirectory, join(run.directory, 'report.json')).replaceAll('\\', '/'),
    }, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
