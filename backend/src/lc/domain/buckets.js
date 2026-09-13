'use strict';
const { STATUS_BY_DISPLAY, BUCKET_TIERS } = require('./constants');

// Accepts wire shapes ({statusCode|status, statusDisplay|status_msg}) and DB rows ({status_code, status_msg}).
function statusOf(sub) {
  if (!sub) return null;
  const direct = sub.status_code ?? sub.statusCode ?? (typeof sub.status === 'number' ? sub.status : null);
  if (direct !== null && direct !== undefined && direct !== '') return Number(direct);
  const disp = sub.status_msg ?? sub.statusDisplay ?? sub.status_display ?? (typeof sub.status === 'string' ? sub.status : null);
  return STATUS_BY_DISPLAY[disp] ?? null;
}

function isEdgeShaped(tc) {
  const t = String(tc || '').trim();
  if (!t) return true;
  const first = t.split('\n')[0].trim();
  if (first === '[]' || first === '""' || first === '0' || first === '1' || first === '[[]]') return true;
  if (/^\[[^,\[\]]*\]$/.test(first)) return true;        // single-element list
  if (/^"[^"]{0,1}"$/.test(first)) return true;          // empty or 1-char string
  if (t.length <= 3) return true;
  return false;
}

function detailsOf(det) {
  if (!det) return null;
  return {
    errorText: String(det.error_text ?? det.runtimeError ?? det.fullCodeOutput ?? det.compileError ?? ''),
    lastTestcase: String(det.last_testcase ?? det.lastTestcase ?? ''),
    expected: String(det.expected_output ?? det.expectedOutput ?? ''),
    output: String(det.code_output ?? det.codeOutput ?? '')
  };
}

function bucketOf(sub, det) {
  const code = statusOf(sub);
  const d = detailsOf(det);
  if (code === 10) return 'ac';
  if (code === 20) return 'ce';
  if (code === 14) return 'tle';
  if (code === 12) return 'mle_state';
  if (code === 13) return 'ole';
  if (code === 15) {
    const e = d ? d.errorText : '';
    if (/signed integer overflow|negation of -2147483648|cannot be represented in type|shift exponent .* too large|left shift of/i.test(e)) return 're_overflow';
    if (/addition of unsigned offset|subtraction of unsigned offset|unsigned offset .* overflowed/i.test(e)) return 're_index';
    if (/RecursionError|StackOverflow|maximum recursion|stack overflow|stack-overflow/i.test(e)) return 're_recursion';
    if (/IndexError|ArrayIndexOutOfBounds|out of range|index \d+ out of bounds|index out of bounds|out_of_range|vector::_M_range_check|load of address .* with insufficient space|store to address .* with insufficient space/i.test(e)) return 're_index';
    if (/KeyError|NoneType|NullPointer|null pointer|nullptr|undefined is not|TypeError: Cannot read/i.test(e)) return 're_null_memo';
    if (/heap-buffer-overflow|AddressSanitizer|SIGSEGV|segmentation/i.test(e)) return 're_index';
    return d ? 're_other' : 're_unknown';
  }
  if (code === 11) {
    if (!d) return 'wa_unknown';
    if (isEdgeShaped(d.lastTestcase)) return 'wa_edge_empty';
    if (/2147483647|-2147483648|1000000000|10\^9|999999999|9223372036854775807/.test(d.lastTestcase)) return 'wa_bounds_overflow';
    const exp = Number(d.expected.trim());
    const got = Number(d.output.trim());
    if (Number.isFinite(exp) && Number.isFinite(got) && got !== exp && (Math.abs(got) >= 1000000007 || ((got - exp) % 1000000007 === 0))) return 'wa_modulo';
    return 'wa_logic';
  }
  return 'other';
}

function tierOf(bucket) {
  return BUCKET_TIERS[bucket] || null;
}

module.exports = { statusOf, isEdgeShaped, bucketOf, tierOf, detailsOf };
