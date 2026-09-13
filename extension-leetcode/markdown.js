// Minimal renderer for tutor replies (ES module).
//
// renderModelText(text, { allowFence }) -> DocumentFragment
//   - paragraphs split on blank lines; single line breaks become <br>
//   - **bold**  -> <strong>
//   - `code`    -> <code>          (contents literal)
//   - at most ONE fenced block (```lang ... ```) -> <pre><code>, only when
//     allowFence is true (rung 4). Every other fence, and everything else,
//     is rendered as literal text.
// Built exclusively with createElement / createTextNode / textContent.
// No markup string is ever assigned to the DOM, and no other syntax is interpreted.

const FENCE_RE = /```[^\n]*\n([\s\S]*?)\n?```/;
const PARAGRAPH_SPLIT_RE = /\n[ \t]*\n+/;
const INLINE_RE = /`([^`\n]+)`|\*\*([^\n]+?)\*\*/g;

function normalize(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim();
}

function appendInline(parent, text) {
  INLINE_RE.lastIndex = 0;
  let cursor = 0;
  let match;
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > cursor) {
      parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    }
    if (match[1] !== undefined) {
      const code = document.createElement('code');
      code.className = 'md-code';
      code.textContent = match[1];
      parent.appendChild(code);
    } else {
      const strong = document.createElement('strong');
      strong.className = 'md-strong';
      strong.textContent = match[2];
      parent.appendChild(strong);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    parent.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

function makeParagraph(block) {
  const p = document.createElement('p');
  p.className = 'md-para';
  const lines = block.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) p.appendChild(document.createElement('br'));
    appendInline(p, line);
  });
  return p;
}

function appendParagraphs(fragment, text) {
  const clean = normalize(text);
  if (!clean) return;
  for (const raw of clean.split(PARAGRAPH_SPLIT_RE)) {
    const block = raw.trim();
    if (block) fragment.appendChild(makeParagraph(block));
  }
}

function makeFence(code) {
  const pre = document.createElement('pre');
  pre.className = 'md-pre';
  const codeEl = document.createElement('code');
  codeEl.className = 'md-fence';
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  return pre;
}

/**
 * Render a single line (no paragraphs, no fences): bold + inline code only.
 * Useful for chips, habit statements and anchor "why" text.
 */
export function renderInline(text) {
  const fragment = document.createDocumentFragment();
  const clean = normalize(text).replace(/\s*\n\s*/g, ' ');
  if (clean) appendInline(fragment, clean);
  return fragment;
}

/**
 * @param {string} text            model reply text
 * @param {{allowFence?: boolean}} [options]
 * @returns {DocumentFragment}
 */
export function renderModelText(text, options = {}) {
  const allowFence = options.allowFence === true;
  const fragment = document.createDocumentFragment();
  const source = normalize(text);
  if (!source) return fragment;

  if (allowFence) {
    const match = FENCE_RE.exec(source);
    if (match) {
      appendParagraphs(fragment, source.slice(0, match.index));
      fragment.appendChild(makeFence(match[1]));
      appendParagraphs(fragment, source.slice(match.index + match[0].length));
      return fragment;
    }
  }

  appendParagraphs(fragment, source);
  return fragment;
}
