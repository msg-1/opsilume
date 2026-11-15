import { createHash } from 'node:crypto';
import type { RemediationAction } from '@prisma/client';

/**
 * The approval fingerprint. An approval is given for exact content, and counts only while the
 * action still has it. The rule for what is covered: everything an approver is shown and
 * everything the webhook receives, plus where it would be carried out.
 *
 *   content      type, title, description, rationale, risk, service, incident, source
 *                investigation, the evidence the rationale cites, and the parameters
 *   target       how the action would be carried out: by hand, or by a webhook (a digest of its
 *                address, never the address itself)
 *   review       whether its source investigation was unverified when it was approved, so that
 *                approvals given without acknowledging that never count (source.ts)
 *
 * Free text is compared after normalising line endings and trailing whitespace only, so
 * re-saving the same text does not invalidate approvals; any other change does. Parameters are
 * compared as values: key order does not matter, nothing else is normalised.
 *
 * The formula is versioned. Approvals given under the earlier formula (v1, which did not cover
 * the rationale, the source or the target) are recognised by legacyApprovalHash and asked for
 * again with their own message, not reported as a change of content.
 */

export type Content = Pick<RemediationAction, 'type' | 'title' | 'description' | 'risk' | 'serviceId'> &
  Partial<Pick<RemediationAction, 'rationale' | 'investigationId' | 'incidentId'>> & { parameters?: unknown };

export type Binding = { unverifiedSource: boolean; executionTarget: string };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  return value ?? null;
}

/** Line endings and trailing whitespace only: what re-saving the same text can change. */
const text = (s: string | null | undefined) =>
  (s ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();

// What persistence.ts appends as the last line of an AI proposal's rationale.
const EVIDENCE_LINE = /(?:^|\n)Evidence: ([^\n]+)$/;

/** The evidence references a rationale cites (its last "Evidence:" line). */
export const citedRefs = (rationale: string | null | undefined) =>
  (text(rationale).match(EVIDENCE_LINE)?.[1] ?? '').split(',').map((r) => r.trim()).filter(Boolean);

/** Identifies exactly what an approver was shown and what the webhook would receive. Sent to the webhook as `contentHash`. */
export function contentHash(a: Content): string {
  const content = {
    v: 2,
    type: a.type,
    title: text(a.title),
    description: text(a.description),
    rationale: text(a.rationale),
    risk: a.risk,
    serviceId: a.serviceId ?? null,
    incidentId: a.incidentId ?? null,
    investigationId: a.investigationId ?? null,
    evidenceRefs: citedRefs(a.rationale),
    parameters: canonical(a.parameters ?? null),
  };
  return sha(JSON.stringify(content));
}

/** How an organisation carries out actions now: by hand, or through a webhook (identified by a digest of its address). */
export const executionTarget = (settings: { remediationWebhookUrl: string | null }) => (settings.remediationWebhookUrl ? `webhook:${sha(settings.remediationWebhookUrl).slice(0, 32)}` : 'manual');

/** The fingerprint approvals are bound to: the content, the execution target and the source review. */
export function approvalHash(a: Content, binding: Binding): string {
  return sha(JSON.stringify({ v: 2, content: contentHash(a), target: binding.executionTarget, unverifiedSource: binding.unverifiedSource }));
}

/** The v1 fingerprint, kept only to recognise approvals given under it. */
export function legacyApprovalHash(a: Content, unverifiedSource: boolean): string {
  const v1 = sha(JSON.stringify({ type: a.type, title: a.title, description: a.description, risk: a.risk, serviceId: a.serviceId ?? null, parameters: canonical(a.parameters ?? null) }));
  return unverifiedSource ? sha(`${v1}:unverified-source-reviewed`) : v1;
}
