import { Prisma } from '@prisma/client';
import type { KnowledgeProvenance } from '../generated/contracts';
import { prisma } from '../lib/prisma';
import { legacyViews } from './investigations/legacy';

/**
 * Provenance of knowledge-base results given to the investigation agent.
 *
 * A postmortem drafted by OPSILUME (analytics.ts) copies text from records that are still stored:
 * what the incident's AI investigations reported (their summaries, narratives and hypotheses, and
 * the "AI investigation completed" timeline entries) and what people recorded on the incident
 * (description, impact, root cause, resolution). Before summaries were built from the
 * assessment, the investigation's summary was a model's own narrative.
 *
 * Provenance is decided from structured records, not from the document's formatting:
 *   - whether OPSILUME generated the document: the `postmortem.create` audit entry written when it
 *     was drafted, the only way a postmortem is linked to an incident through the API;
 *   - which text came from where: passages of the chunk are matched against the stored source
 *     records themselves, so renaming, removing or reordering headings, and where a chunk
 *     happens to start, do not change the answer. The heading is used as one more signal.
 *
 *   document                     written by people: any document OPSILUME did not generate, and
 *                                generated text that matches only the incident's own records
 *   earlier_ai_output            matches what an AI investigation reported, and nothing people recorded
 *   contains_earlier_ai_output   matches both; the AI passages are labelled inline
 *   unknown                      generated, but matches no stored source (edited or paraphrased
 *                                text, a template line, sources no longer stored): not evidence
 *
 * Only `document` can support anything in a report (services/ai/app/evidence.py and the API's
 * guardrails); everything else may be read and cited, never as support. Nothing stored changes.
 */

const FINDINGS_HEADING = 'AI investigation findings';
const COMPLETED = /AI investigation completed\b/;
const INLINE = '[earlier AI output, unverified] ';
// Passages are compared in windows of this many characters (after normalising whitespace and
// case), overlapping by half, so a passage split across two chunks is still found in each part
// that is at least this long. Shorter source text is compared whole, from MIN_PASSAGE characters.
const WINDOW = 48;
const MIN_PASSAGE = 20;

export type Basis = 'not_generated' | 'source_match' | 'heading' | 'incident_record' | 'unmatched' | 'template_only';
export type CurrentAssessment = { investigationId: string; outcome: string | null; summary: string | null };
type Hit = { documentId: string; type: string; section: string | null; content: string };

const normal = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function passages(texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of texts) {
    const t = normal(raw ?? '');
    if (t.length < MIN_PASSAGE) continue;
    if (t.length <= WINDOW) {
      out.add(t);
      continue;
    }
    for (let i = 0; i + WINDOW <= t.length; i += WINDOW / 2) out.add(t.slice(i, i + WINDOW));
    out.add(t.slice(-WINDOW));
  }
  return [...out];
}

/** Whitespace, case and Markdown emphasis are not part of what was recorded. */
const plain = (s: string) => normal(s.replace(/[*_`]/g, ''));

type Sources = {
  /** Windows of AI text, and the whole texts, as recorded. */
  ai: string[];
  aiText: string[];
  /** The model's own words (as opposed to the summary OPSILUME built from the assessment). */
  model: string[];
  modelText: string[];
  /** What people recorded, whole. */
  peopleText: string[];
  current: CurrentAssessment | null;
};

/** The stored records a generated postmortem of each incident copied from. */
async function sourcesFor(organizationId: string, incidentIds: string[]): Promise<Map<string, Sources>> {
  const out = new Map<string, Sources>();
  if (!incidentIds.length) return out;
  const [incidents, investigations, events, actions] = await Promise.all([
    prisma.incident.findMany({ where: { id: { in: incidentIds }, organizationId }, select: { id: true, title: true, description: true, customerImpact: true, rootCause: true, resolution: true } }),
    prisma.$queryRaw<{ id: string; incidentId: string; summary: string | null; outcome: string | null; summarySource: string | null; reportSummary: string | null; narrative: string | null; completedAt: Date | null }[]>`
      SELECT id, "incidentId", summary, outcome, report->>'summarySource' AS "summarySource", report->>'summary' AS "reportSummary", report->>'narrative' AS narrative, "completedAt"
      FROM "Investigation" WHERE "organizationId" = ${organizationId} AND "incidentId" IN (${Prisma.join(incidentIds)}) AND status = 'COMPLETED' AND "demoSessionId" IS NULL
      ORDER BY "completedAt" DESC`,
    prisma.incidentEvent.findMany({ where: { incidentId: { in: incidentIds }, incident: { organizationId } }, select: { incidentId: true, type: true, message: true } }),
    // A public-demo visitor's runs, and what they proposed, belong to that visitor's session only (lib/demo.ts).
    prisma.remediationAction.findMany({ where: { incidentId: { in: incidentIds }, organizationId, OR: [{ investigationId: null }, { investigation: { is: { demoSessionId: null } } }] }, select: { incidentId: true, title: true, proposedByType: true } }),
  ]);
  const hypotheses = investigations.length ? await prisma.hypothesis.findMany({ where: { investigationId: { in: investigations.map((i) => i.id) } }, select: { investigationId: true, title: true, description: true } }) : [];
  const views = await legacyViews(organizationId, investigations.map((i) => i.id));
  for (const incident of incidents) {
    const runs = investigations.filter((i) => i.incidentId === incident.id);
    const model: (string | null)[] = [];
    const hypothesisText: (string | null)[] = [];
    const verified: (string | null)[] = [];
    for (const run of runs) {
      const view = views.get(run.id)?.view;
      // What a model wrote: an older report's stored summary, and any narrative.
      if (view || !run.summarySource) model.push(run.summary, run.reportSummary);
      model.push(run.narrative);
      // What OPSILUME built from the assessment, then or now.
      if (run.summarySource === 'assessment') verified.push(run.summary);
      if (view) verified.push(view.summary);
      for (const h of hypotheses.filter((x) => x.investigationId === run.id)) hypothesisText.push(h.title, h.description);
    }
    const own = <T extends { incidentId: string | null }>(list: T[]) => list.filter((x) => x.incidentId === incident.id);
    const completions = own(events).filter((e) => e.type === 'investigation').map((e) => e.message);
    const aiActions = own(actions).filter((a) => a.proposedByType === 'ai_agent').map((a) => a.title);
    const people = [incident.title, incident.description, incident.customerImpact, incident.rootCause, incident.resolution, ...own(events).filter((e) => e.type !== 'investigation').map((e) => e.message), ...own(actions).filter((a) => a.proposedByType !== 'ai_agent').map((a) => a.title)];
    const latest = runs[0];
    const latestView = latest ? views.get(latest.id)?.view : undefined;
    const current = latest
      ? { investigationId: latest.id, outcome: latestView ? latestView.outcome : latest.outcome, summary: (latestView ? latestView.summarySource === 'assessment' : latest.summarySource === 'assessment') ? (latestView?.summary ?? latest.summary) : null }
      : null;
    const whole = (list: (string | null | undefined)[]) => list.filter((x): x is string => !!x && !!x.trim()).map(plain);
    out.set(incident.id, {
      ai: passages([...model, ...hypothesisText, ...verified, ...completions, ...aiActions]),
      aiText: whole([...model, ...hypothesisText, ...verified, ...completions, ...aiActions]),
      // A model's own summary or narrative: the text that was never checked against the evidence.
      model: passages(model),
      modelText: whole(model),
      peopleText: whole(people),
      current,
    });
  }
  return out;
}

// ───────────────────────── Attributing a chunk, piece by piece ─────────────────────────

// Lines the postmortem template writes itself (analytics.ts): they state nothing about the incident.
const TEMPLATE_LINES = [
  /^#{1,6}\s/,
  /^- \*\*(severity|status|services affected|started|mitigated|resolved|duration):\*\*/i,
  /^_[^_]+_$/, // placeholders such as "_Not recorded._" and "_Owner, action, due date._"
];
// The line the template puts above what an AI investigation reported.
const AI_PREAMBLE = /^analysis by .*overall confidence \d+%.*these are hypotheses, not confirmed causes/i;

type Piece = { line: number; kind: 'template' | 'ai' | 'people' | 'unmatched'; model?: boolean; marker?: boolean };

/**
 * Splits a chunk into the pieces of text the template put together (a line; a timeline entry's
 * message; a hypothesis or action line's parts) and attributes each one: template, AI (contained
 * in, or sharing a window with, what an investigation reported), people (contained in what was
 * recorded on the incident), or unmatched. Text that is both is taken to be AI.
 */
function attribute(content: string, src: Sources | undefined): Piece[] {
  const pieces: Piece[] = [];
  content.split('\n').forEach((raw, line) => {
    const text = raw.trim();
    if (!text) return;
    if (TEMPLATE_LINES.some((r) => r.test(text))) return pieces.push({ line, kind: 'template' });
    if (AI_PREAMBLE.test(plain(text)) || COMPLETED.test(text)) return pieces.push({ line, kind: 'ai', marker: true, model: !!src && src.model.some((w) => plain(text).includes(w)) });
    const body = text
      .replace(/^(?:- |\d+\. )/, '') // list markers
      .replace(/^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC|—) — /, '') // a timeline entry's time
      .replace(/ _\([^)]*\)_$/, '') // ... and who recorded it
      .replace(/ \(\d+%, \w+\)/, '') // a hypothesis's rating
      .replace(/ — [a-z ]+ \((?:low|medium|high) risk\)$/i, ''); // an action's status
    for (const part of body.split(' — ')) {
      const p = plain(part);
      // Too short to say anything: a stray word cut off at a chunk boundary is not a statement.
      if (p.replace(/[^a-z0-9]/g, '').length < 4) continue;
      if (src && (src.aiText.some((t) => t.includes(p)) || src.ai.some((w) => p.includes(w)))) pieces.push({ line, kind: 'ai', model: src.modelText.some((t) => t.includes(p)) || src.model.some((w) => p.includes(w)) });
      else if (src && src.peopleText.some((t) => t.includes(p))) pieces.push({ line, kind: 'people' });
      else pieces.push({ line, kind: 'unmatched' });
    }
  });
  return pieces;
}

const label = (historical: boolean) =>
  `[Earlier AI output, not evidence. ${historical ? 'Written by an AI investigation before OPSILUME checked summaries against the evidence: historical and unverified.' : 'Reported by an AI investigation; its hypotheses were not confirmed.'} Do not cite it as support for a cause.]\n`;
const UNKNOWN_LABEL = '[Origin unknown, not evidence. From a postmortem OPSILUME drafted, but not all of this text matches a record it was drafted from: it may be edited or paraphrased earlier AI output.]\n';
const TEMPLATE_LABEL = '[Template text from a postmortem OPSILUME drafted: it states nothing about the incident and is not evidence.]\n';

export async function withProvenance<H extends Hit>(organizationId: string, hits: H[]): Promise<(H & { provenance: KnowledgeProvenance; provenanceBasis: Basis; currentAssessment?: CurrentAssessment })[]> {
  const postmortemIds = [...new Set(hits.filter((h) => h.type === 'postmortem').map((h) => h.documentId))];
  const [docs, drafted] = postmortemIds.length
    ? await Promise.all([
        prisma.knowledgeDocument.findMany({ where: { id: { in: postmortemIds }, organizationId }, select: { id: true, incidentId: true } }),
        prisma.auditLog.findMany({ where: { organizationId, action: 'postmortem.create', resourceType: 'knowledge_document', resourceId: { in: postmortemIds } }, select: { resourceId: true } }),
      ])
    : [[], []];
  // Drafted by OPSILUME: linked to an incident (only the generator does that through the API), or
  // recorded as drafted. Either is enough, so a lost audit entry does not make one read as written by people.
  const generated = new Set([...drafted.map((a) => a.resourceId), ...docs.filter((d) => d.incidentId).map((d) => d.id)]);
  const incidentOf = new Map(docs.map((d) => [d.id, d.incidentId]));
  const sources = await sourcesFor(organizationId, [...new Set(docs.filter((d) => generated.has(d.id) && d.incidentId).map((d) => d.incidentId!))]);

  return hits.map((h) => {
    if (h.type !== 'postmortem' || !generated.has(h.documentId)) return { ...h, provenance: 'document' as const, provenanceBasis: 'not_generated' as const };
    const incidentId = incidentOf.get(h.documentId);
    const src = incidentId ? sources.get(incidentId) : undefined;
    const attach = src?.current ? { currentAssessment: src.current } : {};
    const pieces = attribute(h.content, src);
    const ai = pieces.filter((p) => p.kind === 'ai');
    const headingHit = (h.section ?? '').includes(FINDINGS_HEADING);
    const people = pieces.some((p) => p.kind === 'people');
    const unmatched = pieces.some((p) => p.kind === 'unmatched');
    if (ai.length || headingHit) {
      // A source match when some AI text was traced to a record; otherwise the template's own markers (heading, preamble, completion line).
      const basis = ai.some((p) => !p.marker) ? ('source_match' as const) : ('heading' as const);
      // Historical: a model's own words, or AI text that is not the summary OPSILUME built from the assessment.
      const historical = !src || ai.some((p) => p.model) || !ai.some((p) => !p.marker);
      if (!people) return { ...h, ...attach, provenance: 'earlier_ai_output' as const, provenanceBasis: basis, content: label(historical) + h.content };
      // Both: each line that is AI output is labelled where it stands; the rest reads as written.
      const aiLines = new Set(ai.map((p) => p.line));
      const content = h.content.split('\n').map((l, i) => (aiLines.has(i) ? l.replace(/^(\s*(?:- |\d+\. )?)/, `$1${INLINE}`) : l)).join('\n');
      return { ...h, ...attach, provenance: 'contains_earlier_ai_output' as const, provenanceBasis: basis, content };
    }
    // Written by people only if every substantive piece is something people recorded.
    if (unmatched) return { ...h, ...attach, provenance: 'unknown' as const, provenanceBasis: 'unmatched' as const, content: UNKNOWN_LABEL + h.content };
    if (people) return { ...h, provenance: 'document' as const, provenanceBasis: 'incident_record' as const };
    return { ...h, provenance: 'unknown' as const, provenanceBasis: 'template_only' as const, content: TEMPLATE_LABEL + h.content };
  });
}
