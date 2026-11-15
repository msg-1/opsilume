import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { GUARDRAIL_LIMITS as LIMITS, OUTCOMES } from '../../generated/contracts';
import { prisma } from '../../lib/prisma';
import { trustedAssessment, verifiedSummary } from './guardrails';

/**
 * Read-time view of reports stored before summaries were built from the assessment
 * (no `summarySource` in the stored report). Their `summary` is whatever the model wrote, and
 * the list, incident, remediation and postmortem views used to show it as the summary.
 *
 * Nothing stored is changed. When a stored model or mock report is read, its summary is
 * derived as a new report's would be: from the stored assessment when that assessment is
 * trusted, otherwise the "outcome not verified" text. The stored summary becomes the
 * unverified narrative. Reports that carry a `summarySource`, rule-based reports and rows
 * without a report are returned exactly as stored.
 */

const SUMMARY = LIMITS.reportSummary;

// Only the fields the summary and the trust check need: an older assessment may lack fields
// added since, and must not be discarded for that.
const storedAssessment = z.object({
  outcome: z.enum(OUTCOMES),
  rationale: z.string().max(4000),
  supportingRefs: z.array(z.string()),
});

export type LegacyView = {
  summary: string;
  summarySource: 'assessment' | 'unverified';
  narrative: string;
  /** The outcome to show: the trusted assessment's, or none. */
  outcome: string | null;
  /** False when the stored assessment is absent, malformed or not trusted. */
  assessmentTrusted: boolean;
};

export type StoredSummary = {
  summary: string | null;
  provider: string | null;
  analysisMode: string | null;
  /** From the stored report. */
  summarySource: unknown;
  reportMode: unknown;
  assessment: unknown;
  hasReport: boolean;
};

/** The view of one stored report, or null when it is shown as stored. */
export function legacyView(stored: StoredSummary, recorded: Set<string>): LegacyView | null {
  if (!stored.hasReport || stored.summarySource != null) return null;
  const mode = typeof stored.reportMode === 'string' ? stored.reportMode : (stored.analysisMode ?? (stored.provider === 'heuristic' ? 'heuristic' : null));
  if (mode === 'heuristic') return null;
  const parsed = storedAssessment.safeParse(stored.assessment);
  const trusted = parsed.success && trustedAssessment(parsed.data, recorded) ? parsed.data : null;
  return {
    summary: trusted ? verifiedSummary(trusted) : SUMMARY.unverified,
    summarySource: trusted ? 'assessment' : 'unverified',
    narrative: (stored.summary ?? '').slice(0, SUMMARY.narrativeMaxLength),
    outcome: trusted?.outcome ?? null,
    assessmentTrusted: !!trusted,
  };
}

type Row = { id: string; summary: string | null; provider: string | null; analysisMode: string | null; summarySource: string | null; reportMode: string | null; assessment: unknown };

/** Views of the legacy reports among `ids` in one organisation; ids absent from the map are shown as stored. */
export async function legacyViews(organizationId: string, ids: string[]): Promise<Map<string, LegacyView>> {
  const views = new Map<string, LegacyView>();
  const unique = [...new Set(ids)];
  if (!unique.length) return views;
  // Only rows whose stored report has no summarySource: new reports are not read again.
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, summary, provider, "analysisMode", report->>'summarySource' AS "summarySource", report->>'analysisMode' AS "reportMode", report->'assessment' AS assessment
    FROM "Investigation"
    WHERE "organizationId" = ${organizationId} AND id IN (${Prisma.join(unique)}) AND report IS NOT NULL AND report->>'summarySource' IS NULL`;
  if (!rows.length) return views;
  const evidence = await prisma.evidence.findMany({ where: { investigationId: { in: rows.map((r) => r.id) } }, select: { investigationId: true, ref: true } });
  const recorded = new Map<string, Set<string>>();
  for (const e of evidence) (recorded.get(e.investigationId) ?? recorded.set(e.investigationId, new Set()).get(e.investigationId)!).add(e.ref);
  for (const r of rows) {
    const view = legacyView({ ...r, hasReport: true }, recorded.get(r.id) ?? new Set());
    if (view) views.set(r.id, view);
  }
  return views;
}

/** Rows that carry a summary (and possibly an outcome), with legacy summaries replaced by their view. */
export function applyViews<T extends { id: string; summary: string | null }>(rows: T[], views: Map<string, LegacyView>): T[] {
  return rows.map((r) => {
    const view = views.get(r.id);
    if (!view) return r;
    return { ...r, summary: view.summary, ...('outcome' in r ? { outcome: view.outcome } : {}) };
  });
}

/** The detail of one investigation, with a legacy report presented as a new one would be. */
export function presentDetail<T extends { summary: string | null; provider: string | null; analysisMode: string | null; outcome: string | null; report: Prisma.JsonValue | null; evidence: { ref: string }[] }>(investigation: T): T {
  const report = investigation.report && typeof investigation.report === 'object' && !Array.isArray(investigation.report) ? (investigation.report as Record<string, unknown>) : null;
  const view = legacyView(
    { summary: (typeof report?.summary === 'string' ? report.summary : null) ?? investigation.summary, provider: investigation.provider, analysisMode: investigation.analysisMode, summarySource: report?.summarySource, reportMode: report?.analysisMode, assessment: report?.assessment, hasReport: !!report },
    new Set(investigation.evidence.map((e) => e.ref)),
  );
  if (!view || !report) return investigation;
  return {
    ...investigation,
    summary: view.summary,
    outcome: view.outcome,
    report: {
      ...report,
      summary: view.summary,
      summarySource: view.summarySource,
      narrative: view.narrative,
      outcome: view.outcome,
      ...(view.assessmentTrusted ? {} : { assessment: null }),
    } as Prisma.JsonValue,
  };
}

// Both formats the completion event has had: with and without a confidence figure.
const COMPLETED = /^AI investigation completed(?: \(\d+% confidence\))?: /;

/** Timeline entries whose completion message quoted a legacy summary show the derived one instead. */
export function applyTimelineViews<T extends { type: string; message: string; metadata: Prisma.JsonValue | null }>(events: T[], views: Map<string, LegacyView>): T[] {
  return events.map((e) => {
    const id = e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>).investigationId : undefined;
    const view = typeof id === 'string' ? views.get(id) : undefined;
    if (e.type !== 'investigation' || !view || !COMPLETED.test(e.message)) return e;
    return { ...e, message: `AI investigation completed: ${view.summary.slice(0, 280)}` };
  });
}
