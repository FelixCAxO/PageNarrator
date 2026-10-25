import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOSED_BETA_FIELDS = Object.freeze([
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
]);

export const REQUIRED_RECOVERY_STATES = Object.freeze([
  'empty_selection',
  'article_text_not_found',
  'host_permission_required',
  'tab_url_hidden',
  'model_setup_failed',
  'tts_generation_failed',
  'scanned_pdf_unsupported',
]);

export const BOOLEAN_FIELDS = Object.freeze([
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
  'recovery_completed',
  'help_needed',
]);

export const ALLOWED_INSTALL_SOURCES = Object.freeze([
  'cws_trusted_tester',
  'cws_unlisted',
  'unpacked_dist',
]);

export const ALLOWED_TRIAGE_STATUSES = Object.freeze([
  '',
  'open',
  'in_progress',
  'fixed',
  'closed',
  'resolved',
]);

export const ALLOWED_TRIAGE_DECISIONS = Object.freeze([
  '',
  'fixed',
  'accepted_for_beta',
  'blocks_beta',
]);

export const ALLOWED_CONFUSION_TAGS = Object.freeze([
  'setup_unclear',
  'permission_unclear',
  'read_action_unclear',
  'playback_control_unclear',
  'advanced_settings_unclear',
  'recovery_unclear',
  'did_not_know_what_to_click',
]);

const FORBIDDEN_FIELDS = new Set([
  'url',
  'page_url',
  'selected_text',
  'page_title',
  'article_text',
  'email',
  'raw_device_id',
  'device_id',
  'custom_voice_endpoint',
  'document_contents',
  'pdf_filename',
  'browsing_history',
]);

const METRICS = Object.freeze({
  install_completion: [(row) => isYes(row.install_completed), 1],
  setup_completed_or_skipped: [(row) => isYes(row.setup_completed_or_intentionally_skipped), 1],
  selected_text_completion: [(row) => isYes(row.selected_text_completed), 0.8],
  full_page_completion: [(row) => isYes(row.full_page_completed), 0.7],
  first_successful_read: [(row) => isYes(row.first_successful_read), 0.85],
  pause_resume_completion: [(row) => isYes(row.pause_resume_completed), 0.8],
  stop_without_help: [(row) => isYes(row.stop_without_help), 0.9],
  speed_change_completion: [(row) => isYes(row.speed_change_completed), 0.8],
  advanced_settings_understood: [(row) => isYes(row.advanced_settings_understood), 0.8],
  setup_understood: [(row) => isYes(row.setup_understood), 0.8],
  recovery_completion: [(row) => isYes(row.recovery_completed) && !isYes(row.help_needed), 0.9],
});

export function parseCsv(text) {
  const records = [];
  let field = '';
  let row = [];
  let quoted = false;

  for (let index = 0; index < String(text).length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      records.push(row);
      field = '';
      row = [];
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    records.push(row);
  }

  const headers = (records.shift() || []).map((header) => header.trim());
  const rows = records
    .filter((record) => record.some((value) => String(value).trim()))
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ''])));
  return { headers, rows };
}

export function summarizeClosedBetaCsv(text) {
  const { headers, rows } = parseCsv(text);
  return summarizeClosedBetaRows(rows, headers);
}

export function summarizeClosedBetaRows(rows, headers = CLOSED_BETA_FIELDS) {
  const failures = [];
  const forbiddenFields = headers
    .map((header) => header.trim().toLowerCase())
    .filter((header) => FORBIDDEN_FIELDS.has(header));

  for (const field of forbiddenFields) failures.push(`Forbidden privacy field present: ${field}.`);

  for (const field of CLOSED_BETA_FIELDS) {
    if (!headers.includes(field)) failures.push(`Missing required field: ${field}.`);
  }

  const testerRows = rows
    .map((row) => ({ alias: normalizeTesterAlias(row.tester_id_alias), row }))
    .filter(({ alias }) => alias);
  if (testerRows.length !== rows.length) failures.push('Every tester row must include tester_id_alias.');

  const aliasCounts = new Map();
  for (const { alias } of testerRows) aliasCounts.set(alias, (aliasCounts.get(alias) || 0) + 1);
  if ([...aliasCounts.values()].some((count) => count > 1)) {
    failures.push('Tester aliases must be unique after trimming and case-folding.');
  }

  const seenAliases = new Set();
  const validRows = testerRows
    .filter(({ alias }) => {
      if (seenAliases.has(alias)) return false;
      seenAliases.add(alias);
      return true;
    })
    .map(({ row }) => row);
  const nValid = validRows.length;
  if (nValid < 20) failures.push(`At least 20 valid tester scripts required; found ${nValid}.`);

  for (const field of ['build_version', 'chrome_version', 'os_family', 'install_source']) {
    if (testerRows.some(({ row }) => !hasText(row[field]))) {
      failures.push(`Every valid tester row must include ${field}.`);
    }
  }

  for (const field of ['candidate_commit', 'candidate_zip_sha256']) {
    if (testerRows.some(({ row }) => !hasText(row[field]))) {
      failures.push(`Every valid tester row must include ${field}.`);
    }
  }

  const buildVersions = new Set(testerRows
    .map(({ row }) => String(row.build_version || '').trim())
    .filter(Boolean));
  if (buildVersions.size !== 1) {
    failures.push(`Exactly one build_version is required across valid tester rows; found ${buildVersions.size}.`);
  }

  const candidateCommits = new Set(testerRows
    .map(({ row }) => String(row.candidate_commit || '').trim())
    .filter(Boolean));
  if (candidateCommits.size !== 1) {
    failures.push(`Exactly one candidate_commit is required across valid tester rows; found ${candidateCommits.size}.`);
  }
  if ([...candidateCommits].some((value) => !/^[a-f0-9]{40}$/i.test(value))) {
    failures.push('candidate_commit must be a full 40-character hexadecimal commit SHA.');
  }

  const candidateZipHashes = new Set(testerRows
    .map(({ row }) => String(row.candidate_zip_sha256 || '').trim().toLowerCase())
    .filter(Boolean));
  if (candidateZipHashes.size !== 1) {
    failures.push(`Exactly one candidate_zip_sha256 is required across valid tester rows; found ${candidateZipHashes.size}.`);
  }
  if ([...candidateZipHashes].some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    failures.push('candidate_zip_sha256 must be a 64-character hexadecimal SHA-256 hash.');
  }

  if (testerRows.some(({ row }) => BOOLEAN_FIELDS.some((field) => !isExactBoolean(row[field])))) {
    failures.push('Boolean fields must be exactly yes or no.');
  }
  if (testerRows.some(({ row }) => !['', 'P0', 'P1', 'P2'].includes(String(row.severity || '').trim()))) {
    failures.push('Severity must be blank, P0, P1, or P2.');
  }
  if (testerRows.some(({ row }) => !ALLOWED_INSTALL_SOURCES.includes(String(row.install_source || '').trim()))) {
    failures.push('install_source must use a documented value.');
  }
  if (testerRows.some(({ row }) => !REQUIRED_RECOVERY_STATES.includes(String(row.assigned_recovery_state || '').trim()))) {
    failures.push('Every assigned_recovery_state must use a documented value.');
  }
  if (testerRows.some(({ row }) => !ALLOWED_TRIAGE_STATUSES.includes(String(row.triage_status || '').trim()))) {
    failures.push('triage_status must use a documented value.');
  }
  if (testerRows.some(({ row }) => !ALLOWED_TRIAGE_DECISIONS.includes(String(row.triage_decision || '').trim()))) {
    failures.push('triage_decision must use a documented value.');
  }
  if (testerRows.some(({ row }) => !hasOnlyAllowedConfusionTags(row.confusion_tags))) {
    failures.push('confusion_tags must use the documented allowlist.');
  }

  const severeRows = validRows.filter((row) => ['P0', 'P1'].includes(normalizeSeverity(row.severity)));
  if (severeRows.some((row) => !hasText(row.triage_owner) || !hasText(row.triage_status) || !hasText(row.triage_decision) || !hasText(row.reproduction_path))) {
    failures.push('Every P0/P1 row must include triage_owner, triage_status, triage_decision, and reproduction_path.');
  }

  const unresolvedP0 = countUnresolvedSeverity(validRows, 'P0');
  const unresolvedP1 = countUnresolvedSeverity(validRows, 'P1');
  const p1Limit = Math.min(5, Math.floor(0.15 * nValid));
  if (unresolvedP0 !== 0) failures.push(`0 unresolved P0 issues required; found ${unresolvedP0}.`);
  if (unresolvedP1 > p1Limit) failures.push(`Unresolved P1 issues must be <= ${p1Limit}; found ${unresolvedP1}.`);

  const metrics = Object.fromEntries(Object.entries(METRICS).map(([name, [predicate, target]]) => {
    const passed = validRows.filter((row) => predicate(row)).length;
    const required = Math.ceil(nValid * target);
    if (passed < required) failures.push(`${name} requires ${required}/${nValid}; found ${passed}.`);
    return [name, { passed, required, target, n: nValid }];
  }));

  const recoveryStateCounts = Object.fromEntries(REQUIRED_RECOVERY_STATES.map((state) => [
    state,
    validRows.filter((row) => String(row.assigned_recovery_state || '').trim() === state).length,
  ]));
  if (Object.values(recoveryStateCounts).some((count) => count < 2)) {
    failures.push('Every required recovery state needs at least 2 assigned attempts.');
  }

  const privacyValueFailures = findPrivacyValueFailures(validRows);
  failures.push(...privacyValueFailures);

  const clickConfusionCount = validRows.filter((row) => hasConfusionTag(row.confusion_tags, 'did_not_know_what_to_click')).length;
  if (clickConfusionCount > 0) {
    failures.push(`Final candidate must have 0 did_not_know_what_to_click reports; found ${clickConfusionCount}.`);
  }

  return {
    pass: failures.length === 0,
    n_valid: nValid,
    p1_limit: p1Limit,
    unresolved_p0: unresolvedP0,
    unresolved_p1: unresolvedP1,
    click_confusion_count: clickConfusionCount,
    metrics,
    recovery_state_counts: recoveryStateCounts,
    failures,
  };
}

function countUnresolvedSeverity(rows, severity) {
  return rows.filter((row) => {
    if (normalizeSeverity(row.severity) !== severity) return false;
    return severity === 'P0' ? !isFixedP0(row) : !isResolvedIssue(row);
  }).length;
}

function normalizeTesterAlias(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSeverity(value) {
  return String(value || '').trim().toUpperCase();
}

function isResolvedIssue(row) {
  const statusResolved = /^(fixed|closed|resolved)$/i.test(String(row.triage_status || '').trim());
  const decisionResolved = /^(fixed|accepted_for_beta)$/i.test(String(row.triage_decision || '').trim());
  return statusResolved && decisionResolved;
}

function isFixedP0(row) {
  const status = String(row.triage_status || '').trim();
  const decision = String(row.triage_decision || '').trim();
  return ['fixed', 'closed', 'resolved'].includes(status) && decision === 'fixed';
}

function isYes(value) {
  return String(value || '').trim() === 'yes';
}

function isExactBoolean(value) {
  return ['yes', 'no'].includes(String(value || '').trim());
}

function hasText(value) {
  return String(value || '').trim().length > 0;
}

function findPrivacyValueFailures(rows) {
  const failures = [];
  const textFields = ['triage_owner', 'reproduction_path', 'confusion_tags'];
  const emailLike = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  for (const [index, row] of rows.entries()) {
    for (const field of textFields) {
      const value = String(row[field] || '');
      if (/https?:\/\//i.test(value)) failures.push(`Privacy URL-like value in ${field} on row ${index + 2}.`);
      if (emailLike.test(value)) failures.push(`Privacy email-like value in ${field} on row ${index + 2}.`);
    }
  }
  return failures;
}

function hasOnlyAllowedConfusionTags(value) {
  const tags = splitConfusionTags(value);
  return tags.every((tag) => ALLOWED_CONFUSION_TAGS.includes(tag));
}

function hasConfusionTag(value, expected) {
  return splitConfusionTags(value).includes(expected);
}

function splitConfusionTags(value) {
  return String(value || '')
    .split(/[|;]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('Usage: npm run beta:scorecard -- path/to/completed-results.csv\n');
    process.exitCode = 1;
    return;
  }
  const csvPath = args.at(-1);
  const report = summarizeClosedBetaCsv(readFileSync(resolve(csvPath), 'utf8'));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
