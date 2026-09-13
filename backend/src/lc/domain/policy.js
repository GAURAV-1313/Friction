'use strict';
const { MAX_RUNG } = require('./constants');

/**
 * decideRung({ requestedRung, planStated, submissionsHere, turns, lastFailAgeS, lastFailBucket, isContest, maxRungGlobal })
 * Pure function of stored facts. Never reads the student's message text.
 */
function decideRung({ requestedRung = null, planStated = false, submissionsHere = 0, turns = 0, lastFailAgeS = null, lastFailBucket = null, isContest = false, maxRungGlobal = MAX_RUNG } = {}) {
  if (isContest) return { locked: true, reason: 'contest_mode' };
  let max = 1;
  let unlock = 'state_a_plan';
  if (planStated) { max = 2; unlock = 'submit_once'; }
  if (submissionsHere >= 1 || turns >= 3) { max = Math.max(max, 3); unlock = 'ask_for_rung_4'; }
  const rung4Ready = submissionsHere >= 2 || turns >= 5;
  if (rung4Ready && requestedRung === 4) { max = 4; unlock = null; }
  else if (rung4Ready) unlock = 'ask_for_rung_4';
  max = Math.min(max, maxRungGlobal);
  let floor = 1;
  let diagnostic = null;
  if (lastFailAgeS !== null && lastFailAgeS !== undefined && lastFailAgeS < 1800 && lastFailBucket) { floor = Math.min(3, max); diagnostic = lastFailBucket; }
  const wanted = requestedRung || floor;
  const rung = Math.max(floor, Math.min(wanted, max));
  const allowedNext = rung4Ready ? 4 : max;
  return {
    locked: false,
    rung,
    max_rung: max,
    floor,
    diagnostic_focus: rung >= 3 ? diagnostic : null,
    code_allowed: rung === 4 ? 'blanked_pseudocode' : 'none',
    must_end_with_question: true,
    unlock_reason: rung >= 4 ? null : unlock,
    allowed_rung_next: allowedNext
  };
}

module.exports = { decideRung };
