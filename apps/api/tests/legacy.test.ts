import { describe, expect, it } from 'vitest';
import { GUARDRAIL_LIMITS as LIMITS } from '../src/generated/contracts';
import { legacyView, type StoredSummary } from '../src/modules/investigations/legacy';

// The read-time view of a report stored before summaries were built from the assessment
// (investigations/legacy.ts). Through the API in intelligence.test.ts; the engine rules here.
const assessment = { outcome: 'INCIDENT', confidence: 0.9, rationale: 'A failure is evident.', supportingRefs: ['E1'] };
const stored = (over: Partial<StoredSummary> = {}): StoredSummary => ({ summary: 'All fine.', provider: 'anthropic', analysisMode: 'llm', summarySource: undefined, reportMode: 'llm', assessment, hasReport: true, ...over });
const recorded = new Set(['E1']);

describe('legacy report view', () => {
  it('leaves a report that already says where its summary comes from as stored', () => {
    for (const summarySource of ['assessment', 'unverified', 'rule_based']) expect(legacyView(stored({ summarySource }), recorded)).toBeNull();
  });

  it('leaves rule-based reports as stored, also when only the provider says so', () => {
    expect(legacyView(stored({ reportMode: 'heuristic' }), recorded)).toBeNull();
    expect(legacyView(stored({ reportMode: undefined, analysisMode: 'heuristic' }), recorded)).toBeNull();
    expect(legacyView(stored({ reportMode: undefined, analysisMode: null, provider: 'heuristic' }), recorded)).toBeNull();
  });

  it('treats a report whose engine is unknown as a model report', () => {
    expect(legacyView(stored({ reportMode: undefined, analysisMode: null, provider: null }), recorded)?.summarySource).toBe('assessment');
  });

  it('leaves a row without a report as stored', () => {
    expect(legacyView(stored({ hasReport: false }), recorded)).toBeNull();
  });

  it('builds the summary from a trusted assessment and keeps the stored text as the narrative', () => {
    expect(legacyView(stored({ reportMode: 'mock' }), recorded)).toEqual({ summary: 'Assessed outcome: INCIDENT. A failure is evident (E1).', summarySource: 'assessment', narrative: 'All fine.', outcome: 'INCIDENT', assessmentTrusted: true });
  });

  it('accepts an older assessment that lacks fields added since', () => {
    expect(legacyView(stored({ assessment: { outcome: 'HEALTHY', rationale: 'Quiet.', supportingRefs: [] } }), recorded)?.summary).toBe('Assessed outcome: HEALTHY. Quiet.');
  });

  it.each([
    ['no assessment', undefined],
    ['an unknown outcome', { ...assessment, outcome: 'FINE' }],
    ['unrecorded evidence', { ...assessment, supportingRefs: ['E1', 'E9'] }],
    ['an incident citing nothing', { ...assessment, supportingRefs: [] }],
  ])('states no outcome for %s', (_label, a) => {
    expect(legacyView(stored({ assessment: a }), recorded)).toEqual({ summary: LIMITS.reportSummary.unverified, summarySource: 'unverified', narrative: 'All fine.', outcome: null, assessmentTrusted: false });
  });

  it('keeps an empty stored summary as an empty narrative', () => {
    expect(legacyView(stored({ summary: null }), recorded)?.narrative).toBe('');
  });
});
