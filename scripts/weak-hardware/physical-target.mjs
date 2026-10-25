// Physical-target attestation. A run counts as physical-target evidence only
// when an attestation file describes the machine it ran on and that
// description matches the host's own inventory. A development host can
// therefore never be relabelled as a low-end target by editing a profile.
import { readFileSync } from 'node:fs';
import os from 'node:os';

export const PHYSICAL_TARGET_ENV = 'PAGENARRATOR_PHYSICAL_TARGET_ATTESTATION';
const REQUIRED_FIELDS = Object.freeze(['machine', 'cpuModel', 'logicalProcessors', 'ramGb', 'gpus', 'attestedBy']);
// Windows reports slightly less RAM than installed; allow 10%.
const RAM_TOLERANCE = 0.1;

/**
 * Observed host inventory used to check an attestation.
 * @param {{ cpus?: () => Array<{ model: string }>, totalmem?: () => number, hostname?: () => string }} [source]
 */
export function readHostInventory({ cpus = os.cpus, totalmem = os.totalmem, hostname = os.hostname } = {}) {
  const list = cpus();
  return {
    hostname: hostname(),
    cpuModel: list[0]?.model?.trim() || null,
    logicalProcessors: list.length || null,
    ramGb: totalmem() / (1024 ** 3),
  };
}

/**
 * Validates an attestation against the observed host.
 * @param {any} attestation
 * @param {{ cpuModel: string|null, logicalProcessors: number|null, ramGb: number, gpus?: string[] }} host
 * @returns {{ attested: boolean, problems: string[] }}
 */
export function verifyPhysicalTargetAttestation(attestation, host) {
  const problems = [];
  for (const field of REQUIRED_FIELDS) {
    if (attestation?.[field] === undefined || attestation[field] === null || attestation[field] === '') problems.push(`missing ${field}`);
  }
  if (problems.length) return { attested: false, problems };
  if (normalize(attestation.cpuModel) !== normalize(host.cpuModel)) {
    problems.push(`CPU "${attestation.cpuModel}" does not match this host's "${host.cpuModel}"`);
  }
  if (Number(attestation.logicalProcessors) !== host.logicalProcessors) {
    problems.push(`${attestation.logicalProcessors} logical processors attested, ${host.logicalProcessors} observed`);
  }
  const ram = Number(attestation.ramGb);
  if (!Number.isFinite(ram) || ram <= 0 || host.ramGb < ram * (1 - RAM_TOLERANCE) || host.ramGb > ram * (1 + RAM_TOLERANCE)) {
    problems.push(`${attestation.ramGb} GB RAM attested, ${host.ramGb.toFixed(1)} GB observed`);
  }
  if (!Array.isArray(attestation.gpus) || !attestation.gpus.length) {
    problems.push('gpus must list the physical adapters');
  } else if (Array.isArray(host.gpus)) {
    const observed = host.gpus.map(normalize);
    const missing = attestation.gpus.filter((gpu) => !observed.includes(normalize(gpu)));
    const extra = host.gpus.filter((gpu) => !attestation.gpus.map(normalize).includes(normalize(gpu)));
    if (missing.length || extra.length) problems.push(`adapters differ (attested only: ${missing.join(', ') || 'none'}; observed only: ${extra.join(', ') || 'none'})`);
  }
  return { attested: problems.length === 0, problems };
}

/**
 * Reads PAGENARRATOR_PHYSICAL_TARGET_ATTESTATION. Returns null when unset and
 * throws when set but not matching, so a mislabelled run cannot start.
 * @param {{ env?: NodeJS.ProcessEnv, host?: any, readFile?: (path: string) => string }} [options]
 */
export function loadPhysicalTarget({ env = process.env, host = readHostInventory(), readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const path = env[PHYSICAL_TARGET_ENV];
  if (!path) return null;
  const attestation = JSON.parse(readFile(path));
  const result = verifyPhysicalTargetAttestation(attestation, host);
  if (!result.attested) throw new Error(`Physical-target attestation rejected: ${result.problems.join('; ')}`);
  return { ...attestation, attested: true, verifiedAgainst: host, verifiedAt: new Date().toISOString() };
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\(r\)|\(tm\)/g, '').replace(/\s+/g, ' ').trim();
}
