import { readFileSync } from 'node:fs';

export const RELEASE_POLICY = JSON.parse(readFileSync(new URL('../../config/release-policy.json', import.meta.url), 'utf8'));

function policyForVersion(version) {
  return [RELEASE_POLICY, ...(RELEASE_POLICY.additionalReleases || [])].find(policy => policy.version === version);
}

export function releaseGateWaiver(gateId, version) {
  const policy = policyForVersion(version);
  if (!policy?.waivedGateIds.includes(gateId)) return null;
  return { gateId, status: 'waived', verification: 'not-performed', version,
    authorizedBy: policy.authorizedBy, authorizedOn: policy.authorizedOn,
    reason: policy.reason, scope: policy.scope };
}

export function releaseAcceptedLimitation(limitationId, version) {
  const limitation = policyForVersion(version)?.acceptedLimitations.find(entry => entry.limitationId === limitationId && entry.version === version);
  return limitation ? { ...limitation } : null;
}
