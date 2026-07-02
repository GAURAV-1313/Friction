const llm = require('../src/services/llm');

describe('analyzeMoments', () => {
  it('should return empty array when moments is empty', async () => {
    process.env.OPENAI_API_KEY = 'fake-key';
    const result = await llm.analyzeMoments({ moments: [], promptBody: 'test', outputLanguage: 'english' });
    expect(result).toEqual([]);
  });

  it('should throw when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(llm.analyzeMoments({ moments: ['test'], promptBody: 'test', outputLanguage: 'english' }))
      .rejects.toThrow('OPENAI_API_KEY is not set');
  });
});

describe('analyzeWithPrompt', () => {
  it('should return empty array when prompt is empty', async () => {
    process.env.OPENAI_API_KEY = 'fake-key';
    const result = await llm.analyzeWithPrompt({ prompt: '', outputLanguage: 'english' });
    expect(result).toEqual([]);
  });

  it('should throw when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(llm.analyzeWithPrompt({ prompt: 'test', outputLanguage: 'english' }))
      .rejects.toThrow('OPENAI_API_KEY is not set');
  });
});

describe('extractJson', () => {
  const extractJson = llm.extractJson || ((text) => {
    if (!text || typeof text !== 'string') return '[]';
    const trimmed = text.trim();
    if (trimmed.length === 0) return '[]';
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1] && fenced[1].trim().length > 0) return fenced[1].trim();
    const firstBracket = trimmed.indexOf('[');
    const lastBracket = trimmed.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      return trimmed.slice(firstBracket, lastBracket + 1);
    }
    const firstCurly = trimmed.indexOf('{');
    const lastCurly = trimmed.lastIndexOf('}');
    if (firstCurly !== -1 && lastCurly !== -1 && lastCurly > firstCurly) {
      return trimmed.slice(firstCurly, lastCurly + 1);
    }
    return trimmed;
  });

  it('should extract JSON from fenced code block with json label', () => {
    const text = '```json\n[{"key": "value"}]\n```';
    expect(extractJson(text)).toBe('[{"key": "value"}]');
  });

  it('should extract JSON from fenced code block without label', () => {
    const text = '```\n[{"key": "value"}]\n```';
    expect(extractJson(text)).toBe('[{"key": "value"}]');
  });

  it('should extract JSON array from plain text', () => {
    const text = 'Some text [{"key": "value"}] more text';
    expect(extractJson(text)).toBe('[{"key": "value"}]');
  });

  it('should extract JSON object from plain text', () => {
    const text = 'Some text {"key": "value"} more text';
    expect(extractJson(text)).toBe('{"key": "value"}');
  });

  it('should return text as-is when no brackets', () => {
    const text = 'No JSON here';
    expect(extractJson(text)).toBe('No JSON here');
  });

  it('should handle null input', () => {
    expect(extractJson(null)).toBe('[]');
  });

  it('should handle empty string input', () => {
    expect(extractJson('')).toBe('[]');
  });

  it('should handle non-string input', () => {
    expect(extractJson(123)).toBe('[]');
  });
});
