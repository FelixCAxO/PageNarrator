import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.PN_COMPARE_OUTPUT || 'artifacts/omnivoice-memory/resources');
const candidate = path.resolve(process.env.PN_COMPARE_CANDIDATE || 'artifacts/omnivoice-memory/candidate/pagenarrator-1.0.0');
const baseline = path.resolve('artifacts/omnivoice-memory/baseline/extension');
mkdirSync(root, { recursive: true });
const reportPath = path.join(root, 'results.json');
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : { startedAt: new Date().toISOString(), runs: [] };
for (const engine of ['omnivoice', 'kokoro']) for (let repeat = 1; repeat <= (engine === 'omnivoice'
  ? Number(process.env.PN_COMPARE_OMNIVOICE_PAIRS || 5) : Number(process.env.PN_COMPARE_KOKORO_PAIRS || 2)); repeat++) {
  for (const variant of repeat % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
    if (report.runs.some(run => run.engine === engine && run.variant === variant && run.repeat === repeat && run.status === 'passed')) continue;
    const output = path.join(root, `${engine}-${variant}-${repeat}`);
    console.log(`Comparing ${engine}: ${variant}, pair ${repeat}`);
    const child = spawn(process.execPath, ['scripts/benchmarks/engine-resources.mjs'], { windowsHide: true, stdio: 'inherit',
      env: { ...process.env, PN_RESOURCE_OUTPUT: output, PN_RESOURCE_EXTENSION_DIR: variant === 'baseline' ? baseline : candidate,
        PN_RESOURCE_PACKAGE_ZIP: variant === 'baseline' ? path.resolve('artifacts/omnivoice-memory/baseline/pagenarrator-1.0.0.zip') : `${candidate}.zip`,
        PN_RESOURCE_ENGINES: engine, PN_RESOURCE_REPEATS: '1' } });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, `Resource run failed: ${engine}/${variant}/${repeat}`);
    const result = JSON.parse(readFileSync(path.join(output, 'results.json'), 'utf8'));
    assert.equal(result.status, 'passed'); assert.equal(result.runs.length, 1);
    report.runs.push({ engine, variant, repeat, directory: output, ...result.runs[0] });
    // Preserve the paired identity rather than the child harness's single-repeat index.
    report.runs.at(-1).repeat = repeat;
    writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2));
  }
}
report.status = 'passed';
writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2));
