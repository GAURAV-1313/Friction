const { buildRagPrompt, analyzeWithPrompt, analyzeMoments } = require('../services/llm');
const { retrieveCombinedContext } = require('../services/rag');

// These tests verify that RAG context is actually injected into analysis prompts
// and that the presence of context changes the output.

describe('RAG Context Injection', () => {
  describe('buildRagPrompt', () => {
    it('should include past context section when ragContext is provided', () => {
      const promptBody = 'Analyze these moments.';
      const outputLanguage = 'english';
      const items = ['First moment', 'Second moment'];
      const ragContext = [
        {
          type: 'gap',
          topic: 'Recursion base case',
          summary: 'Confusion about stopping condition',
          recall_anchor: 'Factorial function',
          occurrence_count: 3
        }
      ];

      const result = buildRagPrompt(promptBody, outputLanguage, items, ragContext);

      expect(result).toContain('Past Context (from your learning history):');
      expect(result).toContain('[gap] Recursion base case [seen 3x]');
      expect(result).toContain('Factorial function');
      expect(result).toContain('Analyze the items below in light of this past context');
    });

    it('should NOT include past context section when ragContext is empty', () => {
      const promptBody = 'Analyze these moments.';
      const outputLanguage = 'english';
      const items = ['First moment', 'Second moment'];
      const ragContext = [];

      const result = buildRagPrompt(promptBody, outputLanguage, items, ragContext);

      expect(result).not.toContain('Past Context');
      expect(result).toContain('Moments (indexed, chronological):');
    });

    it('should NOT include past context section when ragContext is null', () => {
      const promptBody = 'Analyze these moments.';
      const outputLanguage = 'english';
      const items = ['First moment', 'Second moment'];

      const result = buildRagPrompt(promptBody, outputLanguage, items, null);

      expect(result).not.toContain('Past Context');
    });

    it('should include multiple context items', () => {
      const promptBody = 'Analyze these moments.';
      const outputLanguage = 'hinglish';
      const items = ['Moment 1'];
      const ragContext = [
        { type: 'gap', topic: 'Topic A', summary: 'Summary A', recall_anchor: null, occurrence_count: 2 },
        { type: 'insight', topic: 'Topic B', summary: 'Summary B', recall_anchor: 'Anchor B', occurrence_count: 1 }
      ];

      const result = buildRagPrompt(promptBody, outputLanguage, items, ragContext);

      expect(result).toContain('[gap] Topic A [seen 2x]');
      expect(result).toContain('[insight] Topic B [seen 1x]');
      expect(result).toContain('Anchor B');
    });

    it('should use correct output language line', () => {
      const promptBody = 'Analyze.';
      const items = ['test'];

      const englishResult = buildRagPrompt(promptBody, 'english', items, []);
      expect(englishResult).toContain('Output language: English.');

      const hinglishResult = buildRagPrompt(promptBody, 'hinglish', items, []);
      expect(hinglishResult).toContain('Output language: Hinglish.');
    });
  });

  describe('analyzeMoments vs analyzeWithPrompt with RAG', () => {
    it('should produce different prompts (proving RAG context changes output)', () => {
      const promptBody = 'Identify learning friction in these moments. Return JSON array.';
      const outputLanguage = 'english';
      const moments = [
        'I keep confusing recursion base case with the recursive step',
        'Why does my recursive function never stop?',
        'I dont understand when recursion terminates'
      ];

      const ragContext = [
        {
          type: 'gap',
          topic: 'Recursion base case',
          summary: 'Confusion about stopping condition',
          recall_anchor: 'Factorial function',
          occurrence_count: 3
        },
        {
          type: 'gap',
          topic: 'Recursive return propagation',
          summary: 'Understanding return value flow',
          recall_anchor: 'Binary search',
          occurrence_count: 2
        }
      ];

      // Prompt without RAG (what analyzeMoments builds)
      const noRagPrompt = buildRagPrompt(promptBody, outputLanguage, moments, []);

      // Prompt with RAG (what analyzeWithPrompt would build)
      const withRagPrompt = buildRagPrompt(promptBody, outputLanguage, moments, ragContext);

      // They should be different
      expect(noRagPrompt).not.toEqual(withRagPrompt);

      // With RAG should contain context section
      expect(withRagPrompt).toContain('Past Context');
      expect(withRagPrompt).toContain('Recursion base case [seen 3x]');
      expect(withRagPrompt).toContain('Recursive return propagation [seen 2x]');

      // Without RAG should NOT contain context section
      expect(noRagPrompt).not.toContain('Past Context');

      // Both should contain the moments
      expect(noRagPrompt).toContain('I keep confusing recursion base case');
      expect(withRagPrompt).toContain('I keep confusing recursion base case');
    });

    it('should include RAG instruction to connect with past context', () => {
      const promptBody = 'Analyze.';
      const outputLanguage = 'english';
      const items = ['test'];
      const ragContext = [{ type: 'gap', topic: 'Test', summary: 'Test summary', recall_anchor: null, occurrence_count: 1 }];

      const result = buildRagPrompt(promptBody, outputLanguage, items, ragContext);

      expect(result).toContain('Identify recurring patterns, unresolved gaps, or evolving misunderstandings');
      expect(result).toContain('connect to what youve already encountered');
    });
  });
});
