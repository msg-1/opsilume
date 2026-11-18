import type { InvestigationEvent } from '../../integrations/aiService';
import { env } from '../../config/env';
import { VISITOR_FAILURE, forVisitor } from '../../lib/demo';
import { prisma } from '../../lib/prisma';
import { annotate, withSpan } from '../../lib/tracing';
import { applyGuardrails } from './guardrails';
import { persistFinal, saveEngine, saveEvidence, savePlan, stepWriter } from './persistence';
import { reportSchema } from './schema';

/** Thrown out of the stream when the investigation was cancelled while it was running. */
export class Cancelled extends Error {}

/** Thrown when a report arrives for an investigation that already reached another end (failed, interrupted, cancelled). */
export class Superseded extends Error {}

/**
 * Consumes the event stream of one investigation: records steps and evidence as they arrive,
 * and on the final event validates the report, applies the guardrails and stores the result.
 * Before every event it checks whether the investigation was cancelled, and aborts the request
 * to the AI service if so.
 */
export function eventConsumer(investigationId: string, abort: AbortController, { visitorRun = false }: { visitorRun?: boolean } = {}) {
  const state = { provider: 'unknown', finished: false };
  const evidenceRefs = new Set<string>();
  // Reference of each deployment evidence item by the deployment's id, to tell what a rollback acts on.
  const deploymentRefs = new Map<string, string>();
  // Knowledge results quoting an earlier AI investigation: citable, never support (knowledgeProvenance.ts).
  const notEvidence = new Set<string>();
  const addStep = stepWriter(investigationId);

  const assertNotCancelled = async () => {
    const current = await prisma.investigation.findUnique({ where: { id: investigationId }, select: { status: true } });
    if (current?.status === 'CANCELLED') {
      abort.abort();
      throw new Cancelled();
    }
  };

  const onEvent = async (event: InvestigationEvent) => {
    await assertNotCancelled();
    switch (event.type) {
      case 'meta':
        // The public demonstration runs the rule-based engine only (a second line of defence after the
        // check when the investigation is started): a model provider ends the run before it does anything.
        if (env.PUBLIC_DEMO_MODE && event.provider !== 'heuristic') {
          abort.abort();
          throw new Error('The public demo runs the rule-based engine only; the analysis service reported a model provider, so the run was stopped.');
        }
        state.provider = event.provider;
        await saveEngine(investigationId, event.provider, event.model);
        break;
      case 'step':
        if (event.step.type === 'plan') await savePlan(investigationId, event.step.output);
        // A public-demo visitor's failed step keeps what failed, not the error text (lib/demo.ts, forVisitor).
        await addStep(visitorRun && event.step.status === 'failed' ? { ...event.step, detail: event.step.detail == null ? event.step.detail : forVisitor(event.step.detail), output: event.step.output == null ? event.step.output : { error: VISITOR_FAILURE } } : event.step);
        break;
      case 'evidence': {
        const e = event.evidence;
        if (evidenceRefs.has(e.ref)) break;
        evidenceRefs.add(e.ref);
        if (e.kind === 'deployment' && e.sourceId) deploymentRefs.set(e.sourceId, e.ref);
        const provenance = (e.data as { provenance?: unknown } | null | undefined)?.provenance;
        // An allowlist: only text people wrote supports anything. Earlier AI output, unknown origin, a missing or unrecognised value: not evidence.
        if (e.kind === 'document' && provenance !== 'document') notEvidence.add(e.ref);
        await saveEvidence(investigationId, e);
        break;
      }
      case 'final': {
        // One report per run. Anything after it is ignored.
        if (state.finished) break;
        const parsed = reportSchema.safeParse(event.report);
        if (!parsed.success) throw new Error(`AI service returned a malformed report: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        const report = await withSpan('investigation.guardrails', {}, () => applyGuardrails(parsed.data, evidenceRefs, addStep, deploymentRefs, notEvidence));
        const stored = await withSpan('investigation.persist', {}, () => persistFinal(investigationId, report, event.usage, event.engine));
        // Not stored: the investigation stopped being a running one while the report was on its way.
        if (!stored) throw new Superseded();
        annotate({ 'opsilume.engine.mode': report.analysisMode, 'opsilume.investigation.outcome': report.outcome ?? 'none', 'opsilume.investigation.evidence_count': evidenceRefs.size });
        state.finished = true;
        break;
      }
      case 'error':
        throw new Error(event.message);
    }
  };

  return { onEvent, addStep, state };
}
