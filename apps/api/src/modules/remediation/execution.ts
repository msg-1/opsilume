import type { RemediationAction } from '@prisma/client';
import { env } from '../../config/env';
import { decrypt, hmacSha256Hex } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { UnsafeDestinationError, safeRequest } from '../../lib/netguard';
import { getSettings } from '../organization';

/**
 * Carrying out an action. OPSILUME changes nothing itself: a read-only diagnostic is recorded
 * by a person, and a state-changing action is either dispatched to the organisation's
 * remediation webhook or carried out by hand and attested.
 *
 * Every attempt at an action carries the same idempotency key. A timeout, a dropped connection
 * or a 5xx leaves the outcome UNKNOWN, never "executed" and never a clean failure.
 */

export interface ExecutionResult {
  mode: 'webhook' | 'manual' | 'diagnostic';
  success: boolean;
  /** applied: done · not_applied: certainly not done · unknown: may or may not have been done */
  outcome: 'applied' | 'not_applied' | 'unknown';
  summary: string;
  detail?: Record<string, unknown>;
}

/**
 * OpsPilot has no direct access to production. An approved action is carried out either
 *  - by POSTing it (HMAC-signed) to the organisation's remediation webhook, e.g. a CI/CD
 *    pipeline or runbook automation that performs the change, or
 *  - manually by the operator, who then attests in OpsPilot that it was done.
 * In both cases the effect is recorded on the service timeline.
 */
export async function execute(action: RemediationAction, operator: { userId: string; label: string }, approvers: { approverId: string; approvedAt: Date }[], manualNotes?: string, fingerprint = ''): Promise<ExecutionResult> {
  if (action.effect === 'read_only') {
    // Diagnostics are carried out by a person and never dispatched: nothing here can change a system.
    return { mode: 'diagnostic', success: true, outcome: 'applied', summary: `Read-only diagnostic carried out and recorded by ${operator.label}. Nothing was changed.`, detail: manualNotes ? { findings: manualNotes } : undefined };
  }
  const settings = await getSettings(action.organizationId);
  if (!settings.remediationWebhookUrl) {
    return { mode: 'manual', success: true, outcome: 'applied', summary: `Carried out manually and attested by ${operator.label}. OPSILUME did not change any external system.`, detail: manualNotes ? { notes: manualNotes } : undefined };
  }
  const body = JSON.stringify({
    event: 'remediation.execute',
    actionId: action.id,
    // The same for every attempt at this action, so a receiver can refuse to apply it twice.
    idempotencyKey: action.id,
    attempt: action.attempts,
    type: action.type,
    effect: action.effect,
    title: action.title,
    serviceId: action.serviceId,
    incidentId: action.incidentId,
    parameters: action.parameters,
    // The approval fingerprint the approvers gave their approvals for (content.ts).
    contentHash: fingerprint,
    approvals: approvers,
    approvedAt: new Date().toISOString(),
    executedBy: operator.label,
  });
  const secret = settings.remediationWebhookSecretEncrypted ? decrypt(settings.remediationWebhookSecretEncrypted) : null;
  try {
    // The destination is checked as the connection is made, against the addresses it is made
    // to: a host name that resolved to a public address when it was saved, or a moment ago,
    // may not now. Redirects are not followed and the response body is not read.
    const res = await safeRequest(settings.remediationWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'opspilot', 'idempotency-key': action.id, 'x-opspilot-attempt': String(action.attempts), ...(secret ? { 'x-opspilot-signature': `sha256=${hmacSha256Hex(secret, body)}` } : {}) },
      body,
      timeoutMs: env.REMEDIATION_WEBHOOK_TIMEOUT_MS,
    });
    if (res.ok) return { mode: 'webhook', success: true, outcome: 'applied', summary: `Dispatched to remediation webhook (HTTP ${res.status}).`, detail: { status: res.status } };
    // A 4xx is a refusal. A 5xx may have failed half-way through.
    const refused = res.status >= 400 && res.status < 500;
    return {
      mode: 'webhook',
      success: false,
      outcome: refused ? 'not_applied' : 'unknown',
      summary: refused ? `Remediation webhook rejected the request (HTTP ${res.status}). Nothing was applied.` : `Remediation webhook failed (HTTP ${res.status}). Whether the change was applied is unknown: check the target system before retrying.`,
      detail: { status: res.status },
    };
  } catch (err) {
    const failure = networkFailure(err);
    // Refused before any connection was made: certainly nothing was applied.
    if (err instanceof UnsafeDestinationError || (err instanceof AppError && err.status === 400)) {
      return { mode: 'webhook', success: false, outcome: 'not_applied', summary: `Nothing was sent: the remediation webhook address was refused (${FAILURES[failure]}).`, detail: { failure } };
    }
    return {
      mode: 'webhook',
      success: false,
      outcome: 'unknown',
      summary:
        failure === 'timeout'
          ? `The remediation webhook did not answer within ${env.REMEDIATION_WEBHOOK_TIMEOUT_MS / 1000} seconds. The request was sent; whether the change was applied is unknown. Check the target system before retrying.`
          : `The connection to the remediation webhook failed (${FAILURES[failure]}). Whether the change was applied is unknown: check the target system before retrying.`,
      detail: { failure },
    };
  }
}

/**
 * What went wrong on the way to the webhook, as a category only. Error messages from the network
 * library, DNS and TLS name the host, the address or the URL (with any credentials or query
 * string in it), and the summary is stored, shown and audited, so no message text is ever used:
 * only codes and error names, from the error and everything it wraps.
 */
export type NetworkFailure = keyof typeof FAILURES;
const FAILURES = {
  timeout: 'no answer in time',
  resolve: 'the host name could not be resolved',
  disallowed: 'the address is private, loopback or link-local',
  invalid: 'the address is not an acceptable http(s) URL',
  refused: 'the connection was refused',
  reset: 'the connection was reset',
  unreachable: 'the host could not be reached',
  tls: 'the TLS connection could not be established or its certificate was not accepted',
  other: 'a network error',
};

export function networkFailure(err: unknown): NetworkFailure {
  const seen: { code: string; name: string; text: string }[] = [];
  const walk = (e: unknown, depth: number) => {
    if (!e || typeof e !== 'object' || depth > 5) return;
    const x = e as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    seen.push({ code: String(x.code ?? ''), name: String(x.name ?? ''), text: String(x.message ?? '').toLowerCase() });
    walk(x.cause, depth + 1);
    if (Array.isArray(x.errors)) for (const inner of x.errors) walk(inner, depth + 1);
  };
  walk(err, 0);
  const any = (test: (s: (typeof seen)[number]) => boolean) => seen.some(test);
  // Classified from codes and names; the message is read here only to tell the categories apart, never kept.
  if (any((s) => s.name === 'TimeoutError' || s.name === 'AbortError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(s.code))) return 'timeout';
  if (any((s) => ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL'].includes(s.code) || s.text.includes('could not be resolved'))) return 'resolve';
  if (any((s) => s.text.includes('private, loopback or link-local'))) return 'disallowed';
  if (err instanceof AppError && err.status === 400) return 'invalid';
  if (any((s) => s.code === 'ECONNREFUSED')) return 'refused';
  if (any((s) => ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(s.code))) return 'reset';
  if (any((s) => ['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN'].includes(s.code))) return 'unreachable';
  if (any((s) => s.code === 'EPROTO' || /^(ERR_TLS|ERR_SSL)|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(s.code) || /certificate|\bssl\b|\btls\b/.test(s.text))) return 'tls';
  return 'other';
}
