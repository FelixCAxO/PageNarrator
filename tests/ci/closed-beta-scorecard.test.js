import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HEADERS = [
  'tester_id_alias',
  'build_version',
  'candidate_commit',
  'candidate_zip_sha256',
  'chrome_version',
  'os_family',
  'install_source',
  'install_completed',
  'setup_completed_or_intentionally_skipped',
  'setup_understood',
  'selected_text_completed',
  'full_page_completed',
  'first_successful_read',
  'pause_resume_completed',
  'stop_without_help',
  'speed_change_completed',
  'advanced_settings_understood',
  'assigned_recovery_state',
  'recovery_completed',
  'help_needed',
  'severity',
  'triage_owner',
  'triage_status',
  'triage_decision',
  'reproduction_path',
  'confusion_tags',
];

function makeRows(count, overrides = {}) {
  const states = [
    'empty_selection',
    'article_text_not_found',
    'host_permission_required',
    'tab_url_hidden',
    'model_setup_failed',
    'tts_generation_failed',
    'scanned_pdf_unsupported',
  ];
  return Array.from({ length: count }, (_, index) => ({
    tester_id_alias: `t${String(index + 1).padStart(2, '0')}`,
    build_version: '1.0.5',
    candidate_commit: 'a'.repeat(40),
    candidate_zip_sha256: 'b'.repeat(64),
    chrome_version: '126',
    os_family: index % 2 ? 'macOS' : 'Windows',
    install_source: 'unpacked_dist',
    install_completed: 'yes',
    setup_completed_or_intentionally_skipped: 'yes',
    setup_understood: index < 16 ? 'yes' : 'no',
    selected_text_completed: index < 16 ? 'yes' : 'no',
    full_page_completed: index < 14 ? 'yes' : 'no',
    first_successful_read: index < 17 ? 'yes' : 'no',
    pause_resume_completed: index < 16 ? 'yes' : 'no',
    stop_without_help: index < 18 ? 'yes' : 'no',
    speed_change_completed: index < 16 ? 'yes' : 'no',
    advanced_settings_understood: index < 16 ? 'yes' : 'no',
    assigned_recovery_state: states[index % states.length],
    recovery_completed: index < 18 ? 'yes' : 'no',
    help_needed: index < 18 ? 'no' : 'yes',
    severity: '',
    triage_owner: '',
    triage_status: '',
    triage_decision: '',
    reproduction_path: '',
    confusion_tags: '',
    ...overrides,
  }));
}

function writeCsv(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'pn-beta-'));
  const headers = [...HEADERS];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  const csv = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => row[header] ?? '').join(',')),
  ].join('\n');
  const file = join(dir, 'results.csv');
  writeFileSync(file, csv);
  return file;
}

function runScorecard(rows) {
  const scriptPath = fileURLToPath(new URL('../../scripts/summarize-closed-beta.mjs', import.meta.url));
  let output = '';
  try {
    output = execFileSync(process.execPath, [scriptPath, writeCsv(rows)], { encoding: 'utf8' });
  } catch (error) {
    output = error.stdout;
  }
  return JSON.parse(output);
}

describe('closed beta scorecard', () => {
  it('keeps the package script and privacy-safe CSV template in sync', async () => {
    const packageJson = await import('../../package.json', { with: { type: 'json' } });
    const template = await import('node:fs').then(({ readFileSync }) => readFileSync(
      new URL('../../docs/closed-beta-results-template.csv', import.meta.url),
      'utf8',
    ));
    expect(packageJson.default.scripts['beta:scorecard']).toBe('node scripts/summarize-closed-beta.mjs');
    expect(template.trim().split(/\r?\n/)[0].split(',')).toEqual(HEADERS);
    expect(template).not.toMatch(/\b(url|selected_text|page_title|article_text|license_key|email|device_id|custom_voice_endpoint)\b/i);
  });

  it('documents one immutable build without unsupported timing fields', async () => {
    const checklist = await import('node:fs').then(({ readFileSync }) => readFileSync(
      new URL('../../docs/closed-beta-checklist.md', import.meta.url),
      'utf8',
    ));

    expect(checklist).toContain('same-commit `pagenarrator-<version>.zip` artifact');
    expect(checklist).not.toMatch(/task timing|time to complete|median report-to-triage time/i);
  });

  it('passes the recommended 20-tester closed-beta gate at the exact thresholds', () => {
    const report = runScorecard(makeRows(20));

    expect(report.pass).toBe(true);
    expect(report.n_valid).toBe(20);
    expect(report.p1_limit).toBe(3);
    expect(report.metrics.selected_text_completion).toMatchObject({ passed: 16, required: 16 });
    expect(report.metrics.install_completion).toMatchObject({ passed: 20, required: 20 });
    expect(report.metrics.setup_completed_or_skipped).toMatchObject({ passed: 20, required: 20 });
    expect(report.metrics.full_page_completion).toMatchObject({ passed: 14, required: 14 });
    expect(report.metrics.stop_without_help).toMatchObject({ passed: 18, required: 18 });
    expect(report.metrics.recovery_completion).toMatchObject({ passed: 18, required: 18 });
  });

  it('normalizes tester aliases before counting them and rejects duplicates', () => {
    const aliases = [' Same Tester ', 'same tester', 'SAME TESTER'];
    const rows = makeRows(20).map((row, index) => ({
      ...row,
      tester_id_alias: aliases[index % aliases.length],
    }));
    const report = runScorecard(rows);

    expect(report.pass).toBe(false);
    expect(report.n_valid).toBe(1);
    expect(report.failures).toContain('Tester aliases must be unique after trimming and case-folding.');
  });

  it('rejects blank tester aliases without inflating the unique tester count', () => {
    const rows = [
      ...makeRows(20),
      { ...makeRows(1)[0], tester_id_alias: '   ' },
    ];
    const report = runScorecard(rows);

    expect(report.pass).toBe(false);
    expect(report.n_valid).toBe(20);
    expect(report.failures).toContain('Every tester row must include tester_id_alias.');
  });

  it('requires complete build, browser, OS, and install metadata on every counted row', () => {
    const rows = makeRows(20).map((row, index) => {
      if (index === 0) return { ...row, build_version: ' ' };
      if (index === 1) return { ...row, chrome_version: '' };
      if (index === 2) return { ...row, os_family: '\t' };
      if (index === 3) return { ...row, install_source: '' };
      return row;
    });
    const report = runScorecard(rows);

    expect(report.pass).toBe(false);
    expect(report.n_valid).toBe(20);
    expect(report.failures).toContain('Every valid tester row must include build_version.');
    expect(report.failures).toContain('Every valid tester row must include chrome_version.');
    expect(report.failures).toContain('Every valid tester row must include os_family.');
    expect(report.failures).toContain('Every valid tester row must include install_source.');
  });

  it('rejects evidence collected from more than one build version', () => {
    const rows = makeRows(20).map((row, index) => (
      index === 19 ? { ...row, build_version: '1.0.6' } : row
    ));
    const report = runScorecard(rows);

    expect(report.pass).toBe(false);
    expect(report.n_valid).toBe(20);
    expect(report.failures).toContain('Exactly one build_version is required across valid tester rows; found 2.');
  });

  it('requires one immutable candidate commit and ZIP hash across every tester row', () => {
    const mixedCommit = runScorecard(makeRows(20).map((row, index) => (
      index === 19 ? { ...row, candidate_commit: 'c'.repeat(40) } : row
    )));
    const mixedZip = runScorecard(makeRows(20).map((row, index) => (
      index === 19 ? { ...row, candidate_zip_sha256: 'd'.repeat(64) } : row
    )));
    const missingIdentity = runScorecard(makeRows(20, { candidate_commit: '', candidate_zip_sha256: '' }));

    expect(mixedCommit.pass).toBe(false);
    expect(mixedCommit.failures).toContain('Exactly one candidate_commit is required across valid tester rows; found 2.');
    expect(mixedZip.pass).toBe(false);
    expect(mixedZip.failures).toContain('Exactly one candidate_zip_sha256 is required across valid tester rows; found 2.');
    expect(missingIdentity.pass).toBe(false);
    expect(missingIdentity.failures).toContain('Every valid tester row must include candidate_commit.');
    expect(missingIdentity.failures).toContain('Every valid tester row must include candidate_zip_sha256.');
  });

  it('rejects accepted-for-beta P0s even when the status is closed', () => {
    const report = runScorecard(makeRows(20).map((row, index) => (index === 0 ? {
      ...row,
      severity: 'P0',
      triage_owner: 'beta-owner',
      triage_status: 'closed',
      triage_decision: 'accepted_for_beta',
      reproduction_path: 'Open article and observe the broken read path.',
    } : row)));

    expect(report.pass).toBe(false);
    expect(report.failures).toContain('0 unresolved P0 issues required; found 1.');
  });

  it('enforces exact booleans and documented enum values', () => {
    const report = runScorecard(makeRows(20, {
      setup_understood: 'true',
      severity: 'P3',
      install_source: 'placeholder',
      assigned_recovery_state: 'unknown_state',
      triage_status: 'done',
      triage_decision: 'maybe',
      confusion_tags: 'unlisted_tag',
    }));

    expect(report.pass).toBe(false);
    expect(report.failures).toContain('Boolean fields must be exactly yes or no.');
    expect(report.failures).toContain('Severity must be blank, P0, P1, or P2.');
    expect(report.failures).toContain('install_source must use a documented value.');
    expect(report.failures).toContain('Every assigned_recovery_state must use a documented value.');
    expect(report.failures).toContain('triage_status must use a documented value.');
    expect(report.failures).toContain('triage_decision must use a documented value.');
    expect(report.failures).toContain('confusion_tags must use the documented allowlist.');
  });

  it('counts explicit click-confusion feedback and rejects it on the final candidate', () => {
    const report = runScorecard(makeRows(20, {
      confusion_tags: 'did_not_know_what_to_click',
    }));

    expect(report.pass).toBe(false);
    expect(report.click_confusion_count).toBe(20);
    expect(report.failures).toContain('Final candidate must have 0 did_not_know_what_to_click reports; found 20.');
  });

  it('rejects email addresses and URLs in submitted evidence text', () => {
    const report = runScorecard(makeRows(20).map((row, index) => {
      if (index === 1) return { ...row, confusion_tags: 'contact beta@example.com' };
      if (index === 2) return { ...row, reproduction_path: 'Reproduced at https://private.example/article.' };
      return row;
    }));

    expect(report.pass).toBe(false);
    expect(report.failures.some((failure) => failure.includes('Privacy email-like value'))).toBe(true);
    expect(report.failures.some((failure) => failure.includes('Privacy URL-like value'))).toBe(true);
  });

  it('fails privacy fields, P0s, tightened P1 cap, and uncovered recovery states', () => {
    const report = runScorecard(makeRows(20, {
      install_source: '',
      severity: 'P1',
      assigned_recovery_state: 'empty_selection',
    }).map((row, index) => (index === 0 ? { ...row, severity: 'P0', page_url: 'https://private.example' } : row)));

    expect(report.pass).toBe(false);
    expect(report.failures).toContain('0 unresolved P0 issues required; found 1.');
    expect(report.failures).toContain('Unresolved P1 issues must be <= 3; found 19.');
    expect(report.failures).toContain('Forbidden privacy field present: page_url.');
    expect(report.failures).toContain('Every valid tester row must include install_source.');
    expect(report.failures).toContain('Every P0/P1 row must include triage_owner, triage_status, triage_decision, and reproduction_path.');
    expect(report.failures).toContain('Every required recovery state needs at least 2 assigned attempts.');
  });

  it('does not count helped recoveries or open triage rows as launch-ready', () => {
    const helpedRecovery = runScorecard(makeRows(20, {
      recovery_completed: 'yes',
      help_needed: 'yes',
    }));
    const openP0 = runScorecard(makeRows(20).map((row, index) => (index === 0 ? {
      ...row,
      severity: 'P0',
      triage_owner: 'beta-owner',
      triage_status: 'open',
      triage_decision: 'fixed',
      reproduction_path: 'Open article, start read, observe failure.',
    } : row)));
    const whitespaceTriage = runScorecard(makeRows(20).map((row, index) => (index < 3 ? {
      ...row,
      severity: 'P1',
      triage_owner: ' ',
      triage_status: ' ',
      triage_decision: ' ',
      reproduction_path: ' ',
    } : row)));

    expect(helpedRecovery.pass).toBe(false);
    expect(helpedRecovery.failures).toContain('recovery_completion requires 18/20; found 0.');
    expect(openP0.pass).toBe(false);
    expect(openP0.failures).toContain('0 unresolved P0 issues required; found 1.');
    expect(whitespaceTriage.pass).toBe(false);
    expect(whitespaceTriage.failures).toContain('Every P0/P1 row must include triage_owner, triage_status, triage_decision, and reproduction_path.');
  });
});
