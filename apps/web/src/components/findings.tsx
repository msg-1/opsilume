import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, CircleHelp, HelpCircle, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { OutcomeBadge } from '@/components/badges';
import type { Assessment, Integrity, Report, Verification } from '@/lib/types';

const STATUS_WORD: Record<string, string> = {
  exact: 'matches the evidence',
  rounded: 'rounded from the evidence',
  calculated: 'calculated from the evidence',
  estimate: 'an estimate',
  uncited: 'in evidence that is not cited here',
  unsupported: 'not found in the evidence',
};

/**
 * Says whether the figures in a statement were found in the evidence it cites. A statement
 * with an unsupported figure is marked where it is read, not only in a summary elsewhere.
 */
export function VerificationMark({ verification }: { verification?: Verification | null }) {
  if (!verification || verification.status === 'no_claims') return null;
  const { status, checks } = verification;
  const tone = status === 'verified' ? 'text-good-ink' : status === 'partly' ? 'text-warn-ink' : 'text-critical-ink';
  const Icon = status === 'verified' ? CheckCircle2 : status === 'partly' ? HelpCircle : AlertTriangle;
  const label = status === 'verified' ? 'Figures verified' : status === 'partly' ? 'Figures partly verified' : 'Unsupported figure';
  return (
    <details className="group ml-1 inline-block align-baseline">
      <summary className={clsx('inline-flex cursor-pointer list-none items-center gap-1 rounded px-1 text-[12px] font-medium', tone, status === 'unsupported' && 'bg-critical-soft')}>
        <Icon className="size-3.5" aria-hidden />
        {label}
      </summary>
      <ul className="mt-1 mb-1 space-y-0.5 rounded-md border border-line bg-sunken px-2 py-1.5 text-[12px] text-ink-2">
        {checks.map((c, i) => (
          <li key={i} className={clsx(c.status === 'unsupported' && 'text-critical-ink', (c.status === 'uncited' || c.status === 'estimate') && 'text-warn-ink')}>
            <span className="font-mono text-ink">{c.text}</span> · {STATUS_WORD[c.status] ?? c.status}: {c.detail}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The verdict on whether there is a fault at all, with what it rests on and what was not examined. */
/**
 * Who wrote the summary, said in words, so that a summary is never read as more than it is. A
 * summary built from the assessment says so; an older model summary says it was never checked.
 */
export function summaryOrigin(report: Pick<Report, 'summarySource' | 'analysisMode'>, model?: string | null): string {
  if (report.summarySource === 'assessment') return 'Built by OPSILUME from the computed assessment, not written by the model. ';
  if (report.summarySource === 'unverified') return 'The outcome is not verified: this report carries no assessment of the evidence. ';
  if (report.analysisMode === 'heuristic') return 'Produced by rule-based correlation, not a language model. ';
  if (report.analysisMode === 'mock') return 'Produced by a scripted mock, not a language model, and not checked against the assessment. ';
  return `Written by ${model ?? 'a language model'} before summaries were built from the assessment, and not checked against it. `;
}

/**
 * What a model (or the scripted mock) wrote as its summary, kept for anyone who wants to read it,
 * and labelled so that it is never taken for the assessment or for a verified explanation.
 */
/**
 * For an older report whose stored rating is above what the current rules permit: the value
 * recorded at the time, beside the one shown. The shown one is never higher.
 */
export function RecordedRating({ asRecorded, what = 'This rating' }: { asRecorded?: { confidence: number; status?: string } | null; what?: string }) {
  if (!asRecorded) return null;
  return (
    <span className="block text-[12px] text-ink-2">
      {what} is shown as the current rules permit for this report&apos;s verified outcome. Recorded at the time as {Math.round(asRecorded.confidence * 100)}%{asRecorded.status ? ` (${asRecorded.status})` : ''}: historical, not current.
    </span>
  );
}

export function UnverifiedNarrative({ narrative, mode, model, children }: { narrative: string; mode: Report['analysisMode']; model?: string | null; children: ReactNode }) {
  const title = mode === 'mock' ? 'Unverified mock narrative' : 'Unverified model narrative';
  return (
    <section aria-label={title} className="mt-4 rounded-lg border border-dashed border-line-strong p-3">
      <h3 className="text-[12px] font-semibold tracking-wide text-ink-2 uppercase">{title}</h3>
      <p className="mt-1 text-[12px] text-ink-2">
        {mode === 'mock' ? 'Scripted by the mock provider: not an analysis. ' : `Written by ${model ?? 'a language model'}. `}
        Not verified: it may contradict the assessment above, which is what the outcome rests on. Figures in it are checked like the rest of the report.
      </p>
      {narrative.trim() ? <p className="mt-2 max-w-4xl text-[14px] leading-relaxed whitespace-pre-wrap text-ink">{children}</p> : <p className="mt-2 text-[13px] text-ink-2">The model returned no narrative.</p>}
    </section>
  );
}

export function AssessmentCard({ assessment, renderRefs }: { assessment: Assessment; renderRefs: (refs: string[]) => ReactNode }) {
  const pct = Math.round(assessment.confidence * 100);
  const material = assessment.signals.filter((s) => s.level !== 'weak');
  return (
    <section aria-label="Assessment" className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <OutcomeBadge outcome={assessment.outcome} />
        {assessment.outcome !== 'UNDETERMINED' && <span className="tabular text-[13px] text-ink-2" title="Confidence in this assessment, from how much telemetry could be examined and how strong the signals are. It is not the confidence in any hypothesis.">{pct}% confidence in this assessment</span>}
      </div>
      <p className="mt-2 max-w-4xl text-sm text-ink">{assessment.rationale} {assessment.supportingRefs.length > 0 && renderRefs(assessment.supportingRefs)}</p>
      {material.length > 0 && (
        <ul className="mt-2 space-y-1 text-[13px]">
          {material.map((s, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2">
              <span className={clsx('rounded px-1 text-[11px] font-semibold uppercase', s.level === 'strong' ? 'bg-critical-soft text-critical-ink' : 'bg-warn-soft text-warn-ink')}>{s.level} signal</span>
              <span>{s.text}</span>
              {renderRefs(s.evidenceRefs)}
            </li>
          ))}
        </ul>
      )}
      {assessment.missingTelemetry.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <h3 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-ink-2 uppercase"><CircleHelp className="size-3.5" aria-hidden />Not examined</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-ink-2">{assessment.missingTelemetry.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

/** How the report's figures fared against the evidence, with every flagged one listed. */
export function IntegritySummary({ integrity }: { integrity: Integrity }) {
  if (!integrity.checked) return null;
  const unsupported = integrity.flagged.filter((f) => f.status === 'unsupported');
  const soft = integrity.flagged.filter((f) => f.status !== 'unsupported');
  return (
    <section aria-label="Evidence check" className={clsx('rounded-lg border px-3 py-2 text-[13px]', unsupported.length ? 'border-critical/30 bg-critical-soft/50' : 'border-line bg-sunken/60')}>
      <p className="flex items-start gap-1.5">
        {unsupported.length ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical-ink" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0 text-ink-2" aria-hidden />}
        <span>
          <strong className="font-semibold">{integrity.supported} of {integrity.checked}</strong> figures and identifiers in this report match the evidence they cite.
          {unsupported.length > 0 && <> <strong className="font-semibold text-critical-ink">{unsupported.length} could not be matched</strong> and should be treated as unverified.</>}
          {soft.length > 0 && <> {soft.length} {soft.length === 1 ? 'is an estimate or appears' : 'are estimates or appear'} only in evidence that is not cited.</>}
        </span>
      </p>
      {integrity.flagged.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[12px] text-ink-2">Show flagged figures</summary>
          <ul className="mt-1 space-y-0.5 text-[12px]">
            {integrity.flagged.map((f, i) => (
              <li key={i} className={f.status === 'unsupported' ? 'text-critical-ink' : 'text-warn-ink'}>
                <span className="font-mono text-ink">{f.text}</span> in {f.where} · {STATUS_WORD[f.status] ?? f.status}: {f.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
