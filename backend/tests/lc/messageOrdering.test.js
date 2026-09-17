'use strict';
/**
 * lc_chat_messages.created_at is a one-second TIMESTAMP, and chatService writes a
 * turn's user row and assistant row inside the same second. The history query
 * orders by (created_at, id), so `id` is the only thing separating them -- and
 * while ids were random UUIDv4 that tiebreak was a coin flip. Roughly half of all
 * turns rendered the tutor's reply ABOVE the question the student had just asked.
 *
 * These tests pin the property that fixes it: ids sort in creation order.
 */
const { uuid } = require('../../src/lc/db/repo');

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('repo.uuid() is a time-ordered UUIDv7', () => {
  test('shape is a valid v7 UUID with the RFC 4122 variant', () => {
    for (let i = 0; i < 200; i++) expect(uuid()).toMatch(UUID_V7);
  });

  test('ids are unique', () => {
    const ids = Array.from({ length: 5000 }, uuid);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('lexicographic order equals creation order, including within one millisecond', () => {
    // 5000 in a tight loop lands many of these in the same millisecond, which is
    // exactly the case a random v4 id could not order.
    const ids = Array.from({ length: 5000 }, uuid);
    expect([...ids].sort()).toEqual(ids);
  });

  test('order survives a millisecond boundary', () => {
    const before = Array.from({ length: 50 }, uuid);
    const t = Date.now();
    while (Date.now() - t < 3) { /* cross into a new millisecond */ }
    const after = Array.from({ length: 50 }, uuid);
    const all = [...before, ...after];
    expect([...all].sort()).toEqual(all);
  });

  test('the leading bits really are the timestamp', () => {
    const msOf = (id) => parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    const before = Date.now();
    const id = uuid();
    const after = Date.now();
    expect(msOf(id)).toBeGreaterThanOrEqual(before);
    expect(msOf(id)).toBeLessThanOrEqual(after);
  });
});

describe('a turn written inside one second still renders question-then-answer', () => {
  test('sorting by (created_at, id) keeps the user message first', () => {
    // Same second, as chatService writes them.
    const createdAt = '2026-09-17 19:56:49';
    const userRow = { role: 'user', id: uuid(), created_at: createdAt };
    const assistantRow = { role: 'assistant', id: uuid(), created_at: createdAt };

    // repo.messages.listForSession orders DESC then reverses, so replicate that.
    const rows = [assistantRow, userRow]
      .sort((a, b) => (b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)))
      .reverse();

    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
  });

  test('holds across many turns written in the same second', () => {
    const createdAt = '2026-09-17 19:56:49';
    const written = [];
    for (let turn = 0; turn < 40; turn++) {
      written.push({ role: 'user', id: uuid(), created_at: createdAt });
      written.push({ role: 'assistant', id: uuid(), created_at: createdAt });
    }
    const rendered = [...written]
      .sort((a, b) => (b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)))
      .reverse();
    expect(rendered.map((r) => r.id)).toEqual(written.map((r) => r.id));
    // never an assistant row immediately before its own question
    for (let i = 0; i < rendered.length; i += 2) {
      expect(rendered[i].role).toBe('user');
      expect(rendered[i + 1].role).toBe('assistant');
    }
  });
});
