'use strict';
const { decideRung } = require('../../src/lc/domain/policy');
const { MAX_RUNG } = require('../../src/lc/domain/constants');

const base = { requestedRung: null, planStated: false, submissionsHere: 0, turns: 0, lastFailAgeS: null, lastFailBucket: null, isContest: false };
const d = (o) => decideRung({ ...base, ...o });

// Rung ladder matrix: state -> {rung, max_rung, floor, unlock_reason, allowed_rung_next, diagnostic_focus, code_allowed}
const MATRIX = [
  ['nothing yet', {}, { rung: 1, max_rung: 1, floor: 1, unlock_reason: 'state_a_plan', allowed_rung_next: 1, diagnostic_focus: null, code_allowed: 'none' }],
  ['nothing yet, asks for 2', { requestedRung: 2 }, { rung: 1, max_rung: 1, floor: 1, unlock_reason: 'state_a_plan', allowed_rung_next: 1 }],
  ['nothing yet, asks for 4', { requestedRung: 4 }, { rung: 1, max_rung: 1, unlock_reason: 'state_a_plan', allowed_rung_next: 1 }],
  ['plan stated, no request -> floor 1', { planStated: true }, { rung: 1, max_rung: 2, floor: 1, unlock_reason: 'submit_once', allowed_rung_next: 2 }],
  ['plan stated, asks for 2', { planStated: true, requestedRung: 2 }, { rung: 2, max_rung: 2, unlock_reason: 'submit_once', allowed_rung_next: 2 }],
  ['plan stated, asks for 3 -> capped at 2', { planStated: true, requestedRung: 3 }, { rung: 2, max_rung: 2, unlock_reason: 'submit_once' }],
  ['one submission here, asks for 3', { submissionsHere: 1, requestedRung: 3 }, { rung: 3, max_rung: 3, floor: 1, unlock_reason: 'ask_for_rung_4', allowed_rung_next: 3, diagnostic_focus: null, code_allowed: 'none' }],
  ['one submission here, asks for 4 -> capped at 3', { submissionsHere: 1, requestedRung: 4 }, { rung: 3, max_rung: 3, unlock_reason: 'ask_for_rung_4', allowed_rung_next: 3 }],
  ['three turns unlock 3 without a submission', { turns: 3, requestedRung: 3 }, { rung: 3, max_rung: 3, unlock_reason: 'ask_for_rung_4', allowed_rung_next: 3 }],
  ['two turns do not', { turns: 2, requestedRung: 3 }, { rung: 1, max_rung: 1, unlock_reason: 'state_a_plan' }],
  ['two submissions, no explicit ask -> stays 3-capped but next may be 4', { submissionsHere: 2, requestedRung: 3 }, { rung: 3, max_rung: 3, unlock_reason: 'ask_for_rung_4', allowed_rung_next: 4 }],
  ['two submissions and an explicit ask -> rung 4', { submissionsHere: 2, requestedRung: 4 }, { rung: 4, max_rung: 4, unlock_reason: null, allowed_rung_next: 4, code_allowed: 'blanked_pseudocode' }],
  ['five turns and an explicit ask -> rung 4', { turns: 5, requestedRung: 4 }, { rung: 4, max_rung: 4, unlock_reason: null, allowed_rung_next: 4, code_allowed: 'blanked_pseudocode' }],
  ['four turns and an explicit ask -> 3 (turns >= 3 only)', { turns: 4, requestedRung: 4 }, { rung: 3, max_rung: 3, unlock_reason: 'ask_for_rung_4', allowed_rung_next: 3 }],
  ['rung 4 unlocked but student asks for 2', { submissionsHere: 2, requestedRung: 2 }, { rung: 2, max_rung: 3, unlock_reason: 'ask_for_rung_4', allowed_rung_next: 4, code_allowed: 'none' }],
  ['fresh fail here -> floor 3 with diagnostic focus', { submissionsHere: 1, lastFailAgeS: 100, lastFailBucket: 'wa_edge_empty' }, { rung: 3, max_rung: 3, floor: 3, diagnostic_focus: 'wa_edge_empty', unlock_reason: 'ask_for_rung_4' }],
  ['fresh fail overrides a lower request', { submissionsHere: 1, lastFailAgeS: 100, lastFailBucket: 'tle', requestedRung: 1 }, { rung: 3, floor: 3, diagnostic_focus: 'tle' }],
  ['fail at 1799 s still floors', { submissionsHere: 1, lastFailAgeS: 1799, lastFailBucket: 'tle' }, { rung: 3, floor: 3, diagnostic_focus: 'tle' }],
  ['fail at 1800 s does not floor', { submissionsHere: 1, lastFailAgeS: 1800, lastFailBucket: 'tle' }, { rung: 1, floor: 1, diagnostic_focus: null }],
  ['fresh fail without a bucket does not floor', { submissionsHere: 1, lastFailAgeS: 100, lastFailBucket: null }, { rung: 1, floor: 1, diagnostic_focus: null }],
  ['fresh fail with empty-string bucket does not floor', { submissionsHere: 1, lastFailAgeS: 100, lastFailBucket: '' }, { rung: 1, floor: 1, diagnostic_focus: null }],
  ['fresh fail but max is 1 -> floor clamps to max and focus is hidden below rung 3', { lastFailAgeS: 100, lastFailBucket: 'tle' }, { rung: 1, max_rung: 1, floor: 1, diagnostic_focus: null }],
  ['fresh fail with plan only -> floor 2, focus hidden', { planStated: true, lastFailAgeS: 100, lastFailBucket: 'tle' }, { rung: 2, max_rung: 2, floor: 2, diagnostic_focus: null }],
  ['fresh fail and rung 4 asked with unlock -> rung 4 keeps the focus', { submissionsHere: 2, requestedRung: 4, lastFailAgeS: 10, lastFailBucket: 're_overflow' }, { rung: 4, max_rung: 4, floor: 3, diagnostic_focus: 're_overflow', code_allowed: 'blanked_pseudocode' }],
  ['global cap 2 limits max and rung', { submissionsHere: 2, requestedRung: 3, maxRungGlobal: 2 }, { rung: 2, max_rung: 2 }],
  ['global cap 3 blocks rung 4 even when unlocked', { submissionsHere: 2, requestedRung: 4, maxRungGlobal: 3 }, { rung: 3, max_rung: 3 }]
];

describe('decideRung matrix', () => {
  test.each(MATRIX)('%s', (_name, input, expected) => {
    const out = d(input);
    expect(out.locked).toBe(false);
    expect(out).toMatchObject(expected);
  });

  test('every open contract carries the full shape and must end with a question', () => {
    for (const [, input] of MATRIX) {
      const out = d(input);
      expect(Object.keys(out).sort()).toEqual(['allowed_rung_next', 'code_allowed', 'diagnostic_focus', 'floor', 'locked', 'max_rung', 'must_end_with_question', 'rung', 'unlock_reason'].sort());
      expect(out.must_end_with_question).toBe(true);
      expect(out.rung).toBeGreaterThanOrEqual(1);
      expect(out.rung).toBeLessThanOrEqual(out.max_rung);
      expect(out.rung).toBeGreaterThanOrEqual(Math.min(out.floor, out.max_rung));
      expect(out.code_allowed).toBe(out.rung === 4 ? 'blanked_pseudocode' : 'none');
      if (out.rung < 3) expect(out.diagnostic_focus).toBeNull();
      if (out.rung >= 4) expect(out.unlock_reason).toBeNull();
    }
  });
});

describe('contest and defaults', () => {
  test('contest locks everything, whatever else is true', () => {
    expect(d({ isContest: true, submissionsHere: 5, requestedRung: 4, planStated: true })).toEqual({ locked: true, reason: 'contest_mode' });
  });
  test('no arguments at all behaves like "nothing yet"', () => {
    expect(decideRung()).toMatchObject({ locked: false, rung: 1, max_rung: 1, floor: 1, unlock_reason: 'state_a_plan', allowed_rung_next: 1 });
    expect(decideRung({})).toEqual(decideRung());
  });
  test('MAX_RUNG is 4 and is the default global cap', () => {
    expect(MAX_RUNG).toBe(4);
    expect(d({ submissionsHere: 2, requestedRung: 4 }).max_rung).toBe(4);
  });
  test('pure: same input, same output, input untouched', () => {
    const input = { submissionsHere: 1, requestedRung: 3, lastFailAgeS: 5, lastFailBucket: 'tle' };
    const copy = JSON.stringify(input);
    expect(d(input)).toEqual(d(input));
    expect(JSON.stringify(input)).toBe(copy);
  });
});
