async function embedText() {
  return null;
}

async function embedBatch(texts) {
  if (!Array.isArray(texts)) return [];
  return texts.map(() => null);
}

async function embedAndStore() {
  return { skipped: true };
}

module.exports = {
  embedText,
  embedBatch,
  embedAndStore
};