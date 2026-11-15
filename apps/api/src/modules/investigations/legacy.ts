import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { GUARDRAIL_LIMITS as LIMITS, OUTCOMES } from '../../generated/contracts';
import { prisma } from '../../lib/prisma';
import { trustedAssessment, verifiedSummary } from './guardrails';

/**
 * Read-time view of reports stored before summaries were built from the assessment
 * (no `summarySource` in the stored report). Nothing stored is changed.
 *
 * Summary. A stored model or mock report's summary is whatever the model wrote. When it is read,
 * its summary is derived as a new report's would be: from the stored assessment when that
 * assessment is trusted, otherwise the "outcome not verified" text. The stored summary becomes
 * the unverified narrative. Rule-based reports keep their summary.
 *
 * Confidence. Every older report, whatever its engine, is shown with the hypothesis ratings the
 * current rules permit under its trusted outcome (presentHypotheses). Ratings are only ever
 * lowered; the stored values are returned beside the shown ones (`asRecorded`).
 *
 * Reports that carry a `summarySource` were checked by the current rules when they were stored
 * and are returned exactly as stored.
 */

const SUMMARY = LIMITS.reportSummary;

// Only the fields the summary and the trust check need: an older assessment may lack fields
// added since, and must not be discarded for that.
const storedAssessment = z.object({
  outcome: z.enum(OUTCOMES),
  rationale: z.string().max(4000),
  supportingRefs: z.array(z.string()),
});

/** The stored assessment if it is well formed and consistent with the evidence stored for the run, else null. */
export function trustedStoredAssessment(assessment: unknown, recorded: Set<string>) {
  const parsed = storedAssessment.safeParse(assessment);
  return parsed.success && trustedAssessment(parsed.data, recorded) ? parsed.data : null;
}

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

/** Which engine wrote a stored report: the report's own label, else the row's, else a heuristic provider. Unknown is null. */
const engineOf = (stored: Pick<StoredSummary, 'reportMode' | 'analysisMode' | 'provider'>) =>
  typeof stored.reportMode === 'string' ? stored.reportMode : (stored.analysisMode ?? (stored.provider === 'heuristic' ? 'heuristic' : null));

/** The summary view of one stored report, or null when it is shown as stored. */
export function legacyView(stored: StoredSummary, recorded: Set<string>): LegacyView | null {
  if (!stored.hasReport || stored.summarySource != null) return null;
  if (engineOf(stored) === 'heuristic') return null;
  const trusted = trustedStoredAssessment(stored.assessment, recorded);
  return {
    summary: trusted ? verifiedSummary(trusted) : SUMMARY.unverified,
    summarySource: trusted ? 'assessment' : 'unverified',
    narrative: (stored.summary ?? '').slice(0, SUMMARY.narrativeMaxLength),
    outcome: trusted?.outcome ?? null,
    assessmentTrusted: !!trusted,
  };
}

// ───────────────────────── Confidence ─────────────────────────

export type StoredHypothesis = { confidence: number; status: string; evidenceRefs: string[] };
export type AsRecorded = { confidence: number; status: string };
const RANK: Record<string, number> = { unlikely: 0, possible: 1, likely: 2 };
const lower = (status: string, to: 'possible' | 'unlikely') => ((RANK[status] ?? 2) > RANK[to]! ? to : status);

/**
 * The rating the current rules permit for each stored hypothesis, given the trusted outcome
 * (null when there is none) and the evidence stored for the run. The same caps as the API's and
 * the AI service's guardrails, applied to what is shown: confidence and status only go down,
 * the order is kept, and each changed hypothesis carries its stored values in `asRecorded`.
 */
export function presentHypotheses<T extends StoredHypothesis>(hypotheses: T[], outcome: string | null, recorded: Set<string>, engine: string | null): (T & { asRecorded?: AsRecorded })[] {
  const max = engine && engine in LIMITS.maxConfidence ? LIMITS.maxConfidence[engine as keyof typeof LIMITS.maxConfidence] : LIMITS.maxConfidence.llm;
  return hypotheses.map((h) => {
    let { confidence, status } = h;
    // Evidence that was never recorded supports nothing.
    if (!h.evidenceRefs.some((r) => recorded.has(r))) {
      confidence = Math.min(confidence, LIMITS.unsupportedHypothesisCap);
      status = lower(status, 'possible');
    }
    confidence = Math.min(confidence, max);
    if (status === 'likely' && confidence < LIMITS.likelyMinimumConfidence) status = 'possible';
    if (outcome === 'HEALTHY' || outcome === 'UNDETERMINED') {
      confidence = Math.min(confidence, LIMITS.noFaultHypothesisCap);
      status = 'unlikely';
    } else if (outcome !== LIMITS.outcomeAllowingProductionChanges) {
      // DEGRADED: the cause is not established. No trusted outcome: nothing is verified.
      confidence = Math.min(confidence, LIMITS.unestablishedCauseCap);
      status = lower(status, 'possible');
    }
    if (confidence === h.confidence && status === h.status) return h;
    return { ...h, confidence, status, asRecorded: { confidence: h.confidence, status: h.status } };
  });
}

/** Overall confidence shown: never above the strongest hypothesis shown (0.2 without any), never above what was stored. */
export const presentConfidence = (stored: number, shown: StoredHypothesis[]) => Math.min(stored, shown.length ? Math.max(...shown.map((h) => h.confidence)) : 0.2);

// ───────────────────────── Loading for lists ─────────────────────────

/** What changes when an older report is read: its summary view (model and mock only) and its overall confidence. */
export type LegacyRead = { view: LegacyView | null; confidence: number | null; confidenceAsRecorded: number | null };

type Row = { id: string; summary: string | null; provider: string | null; analysisMode: string | null; confidence: number | null; summarySource: string | null; reportMode: string | null; assessment: unknown };

/** The read-time views of the older reports among `ids` in one organisation; ids absent from the map are shown as stored. */
export async function legacyViews(organizationId: string, ids: string[]): Promise<Map<string, LegacyRead>> {
  const reads = new Map<string, LegacyRead>();
  const unique = [...new Set(ids)];
  if (!unique.length) return reads;
  // Only rows whose stored report has no summarySource: new reports are not read again.
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, summary, provider, "analysisMode", confidence, report->>'summarySource' AS "summarySource", report->>'analysisMode' AS "reportMode", report->'assessment' AS assessment
    FROM "Investigation"
    WHERE "organizationId" = ${organizationId} AND id IN (${Prisma.join(unique)}) AND report IS NOT NULL AND report->>'summarySource' IS NULL`;
  if (!rows.length) return reads;
  const legacyIds = rows.map((r) => r.id);
  const [evidence, hypotheses] = await Promise.all([
    prisma.evidence.findMany({ where: { investigationId: { in: legacyIds } }, select: { investigationId: true, ref: true } }),
    prisma.hypothesis.findMany({ where: { investigationId: { in: legacyIds } }, select: { investigationId: true, confidence: true, status: true, evidenceRefs: true } }),
  ]);
  const group = <V>(list: V[], key: (v: V) => string) => {
    const m = new Map<string, V[]>();
    for (const v of list) (m.get(key(v)) ?? m.set(key(v), []).get(key(v))!).push(v);
    return m;
  };
  const evidenceBy = group(evidence, (e) => e.investigationId);
  const hypothesesBy = group(hypotheses, (h) => h.investigationId);
  for (const r of rows) {
    const recorded = new Set((evidenceBy.get(r.id) ?? []).map((e) => e.ref));
    const view = legacyView({ ...r, hasReport: true }, recorded);
    const outcome = trustedStoredAssessment(r.assessment, recorded)?.outcome ?? null;
    const shown = presentHypotheses(hypothesesBy.get(r.id) ?? [], outcome, recorded, engineOf(r));
    const confidence = r.confidence == null ? null : presentConfidence(r.confidence, shown);
    const changed = confidence !== r.confidence;
    if (view || changed) reads.set(r.id, { view, confidence, confidenceAsRecorded: changed ? r.confidence : null });
  }
  return reads;
}

/** Rows that carry a summary (and possibly an outcome and a confidence), with older reports shown through their view. */
export function applyViews<T extends { id: string }>(rows: T[], reads: Map<string, LegacyRead>): T[] {
  return rows.map((r) => {
    const read = reads.get(r.id);
    if (!read) return r;
    return {
      ...r,
      ...(read.view && 'summary' in r ? { summary: read.view.summary, ...('outcome' in r ? { outcome: read.view.outcome } : {}) } : {}),
      ...('confidence' in r && read.confidenceAsRecorded != null ? { confidence: read.confidence } : {}),
    };
  });
}

// ───────────────────────── The detail ─────────────────────────

type DetailHypothesis = StoredHypothesis & { rank: number };

/** The detail of one investigation, with an older report presented as a new one would be. */
export function presentDetail<
  T extends { summary: string | null; provider: string | null; analysisMode: string | null; outcome: string | null; confidence: number | null; report: Prisma.JsonValue | null; evidence: { ref: string }[]; hypotheses: DetailHypothesis[] },
>(investigation: T): Omit<T, 'hypotheses'> & { hypotheses: (T['hypotheses'][number] & { asRecorded?: AsRecorded })[]; confidenceAsRecorded?: number } {
  const report = investigation.report && typeof investigation.report === 'object' && !Array.isArray(investigation.report) ? (investigation.report as Record<string, unknown>) : null;
  if (!report || report.summarySource != null) return investigation;
  const recorded = new Set(investigation.evidence.map((e) => e.ref));
  const stored = { summary: (typeof report.summary === 'string' ? report.summary : null) ?? investigation.summary, provider: investigation.provider, analysisMode: investigation.analysisMode, summarySource: report.summarySource, reportMode: report.analysisMode, assessment: report.assessment, hasReport: true };
  const view = legacyView(stored, recorded);
  const outcome = trustedStoredAssessment(report.assessment, recorded)?.outcome ?? null;
  const engine = engineOf(stored);
  const hypotheses = presentHypotheses(investigation.hypotheses, outcome, recorded, engine);
  const confidence = investigation.confidence == null ? null : presentConfidence(investigation.confidence, hypotheses);
  // The copy inside the report gets the same ratings, matched by position (both are stored in rank order).
  const reportHypotheses = Array.isArray(report.hypotheses)
    ? presentHypotheses(
        (report.hypotheses as Record<string, unknown>[]).map((h) => ({ ...h, confidence: Number(h.confidence ?? 0), status: String(h.status ?? 'possible'), evidenceRefs: Array.isArray(h.evidenceRefs) ? (h.evidenceRefs as string[]) : [] })),
        outcome, recorded, engine,
      ).map(({ asRecorded: _drop, ...h }) => h)
    : report.hypotheses;
  const reportConfidence = typeof report.confidence === 'number' && Array.isArray(reportHypotheses) ? presentConfidence(report.confidence, reportHypotheses as StoredHypothesis[]) : report.confidence;
  return {
    ...investigation,
    ...(view ? { summary: view.summary, outcome: view.outcome } : {}),
    confidence,
    ...(confidence !== investigation.confidence && investigation.confidence != null ? { confidenceAsRecorded: investigation.confidence } : {}),
    hypotheses,
    report: {
      ...report,
      ...(view ? { summary: view.summary, summarySource: view.summarySource, narrative: view.narrative, outcome: view.outcome, ...(view.assessmentTrusted ? {} : { assessment: null }) } : {}),
      hypotheses: reportHypotheses,
      confidence: reportConfidence,
    } as Prisma.JsonValue,
  };
}

// Both formats the completion event has had: with and without a confidence figure.
const COMPLETED = /^AI investigation completed(?: \(\d+% confidence\))?: /;

/** Timeline entries whose completion message quoted an older model summary show the derived one instead. */
export function applyTimelineViews<T extends { type: string; message: string; metadata: Prisma.JsonValue | null }>(events: T[], reads: Map<string, LegacyRead>): T[] {
  return events.map((e) => {
    const id = e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>).investigationId : undefined;
    const read = typeof id === 'string' ? reads.get(id) : undefined;
    if (e.type !== 'investigation' || !read || !COMPLETED.test(e.message)) return e;
    if (read.view) return { ...e, message: `AI investigation completed: ${read.view.summary.slice(0, 280)}` };
    // A rule-based report keeps its words; a confidence figure the current rules would not show is dropped.
    if (read.confidenceAsRecorded != null) return { ...e, message: e.message.replace(COMPLETED, 'AI investigation completed: ') };
    return e;
  });
}
