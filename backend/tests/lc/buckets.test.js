'use strict';
const { statusOf, isEdgeShaped, bucketOf, tierOf, detailsOf } = require('../../src/lc/domain/buckets');
const { BUCKET_TIERS } = require('../../src/lc/domain/constants');

// Every message below is a synthetic judge string shaped like the real thing (C++ UBSan / ASan first, then Python/Java/JS).
const re = (error_text) => [{ status_code: 15, status_msg: 'Runtime Error' }, { error_text, last_testcase: '[1,2]', expected_output: '', code_output: '' }];
const wa = (last_testcase, expected_output = '', code_output = '') => [{ status_code: 11, status_msg: 'Wrong Answer' }, { last_testcase, expected_output, code_output, error_text: '' }];
const dbRow = { status_code: 11, status_msg: 'Wrong Answer', last_testcase: '[]', expected_output: '0', code_output: '1', error_text: '' };

const TABLE = [
  ['AC', [{ status_code: 10 }, null], 'ac'],
  ['AC ignores details', [{ status_code: 10 }, { last_testcase: '[]' }], 'ac'],
  ['CE', [{ status_code: 20 }, null], 'ce'],
  ['TLE', [{ status_code: 14 }, null], 'tle'],
  ['TLE with details is still tle', [{ status_code: 14 }, { last_testcase: '[]' }], 'tle'],
  ['MLE', [{ status_code: 12 }, null], 'mle_state'],
  ['OLE', [{ status_code: 13 }, null], 'ole'],
  ['RE UBSan signed integer overflow', re('runtime error: signed integer overflow: 27131803 + 2123074792 cannot be represented in type int'), 're_overflow'],
  ['RE UBSan negation of INT_MIN', re('runtime error: negation of -2147483648 cannot be represented in type int'), 're_overflow'],
  ['RE UBSan shift exponent too large', re('runtime error: shift exponent 32 is too large for 32-bit type int'), 're_overflow'],
  ['RE UBSan left shift', re('runtime error: left shift of 1 by 31 places cannot be represented in type int'), 're_overflow'],
  ['RE cannot be represented (long)', re("runtime error: value 1e+19 is outside the range of representable values and cannot be represented in type 'long'"), 're_overflow'],
  ['RE UBSan unsigned offset addition -> index', re('runtime error: addition of unsigned offset to 0x602000000010 overflowed to 0x60200000000c'), 're_index'],
  ['RE UBSan unsigned offset subtraction -> index', re('runtime error: subtraction of unsigned offset from 0x602000000010 overflowed to 0x60200000000c'), 're_index'],
  ['RE Python RecursionError', re('RecursionError: maximum recursion depth exceeded in comparison'), 're_recursion'],
  ['RE Java StackOverflowError', re('Exception in thread "main" java.lang.StackOverflowError'), 're_recursion'],
  ['RE ASan stack-overflow beats the ASan index rule', re('AddressSanitizer: stack-overflow on address 0x7ffd12345678'), 're_recursion'],
  ['RE Python IndexError', re('IndexError: list index out of range'), 're_index'],
  ['RE libstdc++ vector range check', re('terminate called after throwing an instance of std::out_of_range: vector::_M_range_check: __n (which is 3) >= this->size() (which is 3)'), 're_index'],
  ['RE Java ArrayIndexOutOfBounds', re('java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 5'), 're_index'],
  ['RE Python KeyError', re('KeyError: 5'), 're_null_memo'],
  ['RE Python NoneType', re("AttributeError: 'NoneType' object has no attribute 'val'"), 're_null_memo'],
  ['RE UBSan null pointer member access', re("runtime error: member access within null pointer of type 'TreeNode'"), 're_null_memo'],
  ['RE JS undefined read', re("TypeError: Cannot read properties of undefined (reading 'val')"), 're_null_memo'],
  ['RE ASan heap-buffer-overflow', re('AddressSanitizer: heap-buffer-overflow on address 0x602000000014 at pc 0x000000345678'), 're_index'],
  ['RE SIGSEGV', re('Fatal signal: SIGSEGV (Segmentation violation)'), 're_index'],
  ['RE segmentation fault', re('Segmentation fault (core dumped)'), 're_index'],
  ['RE unmatched message with details -> re_other', re('terminate called after throwing an instance of std::bad_alloc'), 're_other'],
  ['RE empty message with details -> re_other', re(''), 're_other'],
  ['RE without details -> re_unknown', [{ status_code: 15 }, null], 're_unknown'],
  ['WA without details -> wa_unknown', [{ status_code: 11 }, null], 'wa_unknown'],
  ['WA empty testcase', wa('', '1', '0'), 'wa_edge_empty'],
  ['WA []', wa('[]', '0', '-1'), 'wa_edge_empty'],
  ['WA single-element list', wa('[5]', '5', '0'), 'wa_edge_empty'],
  ['WA one-char string', wa('"a"', '1', '0'), 'wa_edge_empty'],
  ['WA edge shape wins over bounds token', wa('[2147483647]', '1', '0'), 'wa_edge_empty'],
  ['WA INT_MAX in input', wa('[2147483647,1]', '2147483648', '-2147483648'), 'wa_bounds_overflow'],
  ['WA 1e9 literal in input', wa('1000000000\n[1,2,3]', '3', '2'), 'wa_bounds_overflow'],
  ['WA 10^9 token in input', wa('n = 10^9\n[1,2,3]', '3', '2'), 'wa_bounds_overflow'],
  ['WA output differs by exactly one modulus', wa('[1,2,3,4]', '5', '1000000012'), 'wa_modulo'],
  ['WA output past the modulus', wa('[1,2,3,4]', '3', '2000000014'), 'wa_modulo'],
  ['WA negative result, missing modulo normalisation', wa('[1,2,3,4]', '1000000004', '-3'), 'wa_modulo'],
  ['WA numeric logic error', wa('[3,1,5,8]', '167', '150'), 'wa_logic'],
  ['WA non-numeric outputs', wa('[1,2,3]', '[1,2]', '[2,1]'), 'wa_logic'],
  ['WA numerically equal outputs fall to logic', wa('[1,2,3]', '5', '5.0'), 'wa_logic'],
  ['status 50 (restricted) -> other', [{ status_code: 50 }, null], 'other'],
  ['status 16 internal error -> other', [{ status_code: 16 }, null], 'other'],
  ['no status at all -> other', [{}, null], 'other'],
  ['wire shape RE (statusCode + runtimeError)', [{ statusCode: 15, statusDisplay: 'Runtime Error' }, { runtimeError: 'runtime error: signed integer overflow: 1 + 2147483647 cannot be represented in type int' }], 're_overflow'],
  ['wire shape WA (statusDisplay + lastTestcase)', [{ statusDisplay: 'Wrong Answer' }, { lastTestcase: '[7]', expectedOutput: '7', codeOutput: '0' }], 'wa_edge_empty'],
  ['display-only status string', [{ status: 'Time Limit Exceeded' }, null], 'tle'],
  ['DB row passed as both sub and details', [dbRow, dbRow], 'wa_edge_empty'],
  ['fullCodeOutput as the error source', [{ status_code: 15 }, { fullCodeOutput: 'KeyError: 3' }], 're_null_memo'],
  ['compileError as the error source', [{ status_code: 15 }, { compileError: 'stack overflow while compiling template' }], 're_recursion'],
  ['error_text wins over runtimeError when both present', [{ status_code: 15 }, { error_text: 'RecursionError', runtimeError: 'KeyError' }], 're_recursion']
];

describe('bucketOf', () => {
  test('table has at least 30 cases', () => { expect(TABLE.length).toBeGreaterThanOrEqual(30); });
  test.each(TABLE)('%s', (_name, [sub, det], expected) => { expect(bucketOf(sub, det)).toBe(expected); });

  // UBSan's "index N out of bounds for type" (fixed: the regex accepts a number between index and out of bounds).
  test('UBSan "index N out of bounds for type" should be re_index', () => {
    expect(bucketOf(...re("runtime error: index 5 out of bounds for type 'int [5]'"))).toBe('re_index');
  });
});

describe('isEdgeShaped', () => {
  test.each([
    ['', true], [null, true], [undefined, true], ['[]', true], ['""', true], ['0', true], ['1', true], ['[[]]', true],
    ['[7]', true], ['[-3]', true], ['["ab"]', true], ['"a"', true], ['  []  ', true], ['2', true], ['ab', true], ['abc', true],
    ['[1]\n[2,3]', true],
    ['"ab"', false], ['abcd', false], ['[1,2]', false], ['[[1,2]]', false], ['[1,2,3]\n5', false], ['12345', false], ['[2147483647,1]', false]
  ])('isEdgeShaped(%j) -> %s', (tc, expected) => { expect(isEdgeShaped(tc)).toBe(expected); });
});

describe('statusOf', () => {
  test.each([
    [{ status_code: 11 }, 11],
    [{ statusCode: '14' }, 14],
    [{ status: 10 }, 10],
    [{ status: 'Accepted' }, 10],
    [{ status_msg: 'Wrong Answer' }, 11],
    [{ statusDisplay: 'Time Limit Exceeded' }, 14],
    [{ status_display: 'Runtime Error' }, 15],
    [{ status_code: null, status_msg: 'Compile Error' }, 20],
    [{ status_code: '', statusDisplay: 'Memory Limit Exceeded' }, 12],
    [{ statusDisplay: 'Output Limit Exceeded' }, 13],
    [{ status: 'Internal Error' }, 16],
    [{ status: 'Unknown Error' }, 21],
    [{ status_code: 0 }, 0],
    [{ status_code: 15, status_msg: 'Accepted' }, 15],
    [{ status_msg: 'Bogus Verdict' }, null],
    [{}, null],
    [null, null],
    [undefined, null]
  ])('statusOf(%j) -> %s', (sub, expected) => { expect(statusOf(sub)).toBe(expected); });
});

describe('tierOf', () => {
  test('matches the calibration tiers exactly', () => {
    expect(BUCKET_TIERS).toEqual({ re_overflow: 'high', re_null_memo: 'high', tle: 'high', wa_logic: 'medium', wa_modulo: 'medium', wa_edge_empty: 'medium', re_index: 'medium', mle_state: 'low' });
  });
  test.each(Object.entries(BUCKET_TIERS))('tierOf(%s) -> %s', (bucket, tier) => { expect(tierOf(bucket)).toBe(tier); });
  test.each(['ac', 'ce', 'ole', 'other', 're_other', 're_recursion', 're_unknown', 'wa_unknown', 'wa_bounds_overflow', 'nope', undefined, null])('tierOf(%s) -> null', (bucket) => {
    expect(tierOf(bucket)).toBeNull();
  });
  test('no tier is ever attached to a runtime-percentile signal', () => {
    expect(Object.keys(BUCKET_TIERS).some((k) => /percentile/.test(k))).toBe(false);
  });
});

describe('detailsOf', () => {
  test('null for missing details', () => { expect(detailsOf(null)).toBeNull(); expect(detailsOf(undefined)).toBeNull(); });
  test('coerces every field to a string with DB-row precedence', () => {
    expect(detailsOf({ error_text: 'E', last_testcase: '[1]', expected_output: '1', code_output: '2' })).toEqual({ errorText: 'E', lastTestcase: '[1]', expected: '1', output: '2' });
    expect(detailsOf({ runtimeError: 'R', lastTestcase: 'L', expectedOutput: 'X', codeOutput: 'O' })).toEqual({ errorText: 'R', lastTestcase: 'L', expected: 'X', output: 'O' });
    expect(detailsOf({})).toEqual({ errorText: '', lastTestcase: '', expected: '', output: '' });
    expect(detailsOf({ error_text: null, runtimeError: 'R' })).toEqual({ errorText: 'R', lastTestcase: '', expected: '', output: '' });
  });
});
