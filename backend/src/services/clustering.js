const { embedBatch, cosineSimilarity } = require('./embeddings');

const CLUSTER_SIM_THRESHOLD = Number(process.env.CLUSTER_SIM_THRESHOLD || 0.7);

async function clusterMoments(pool, moments) {
  if (!moments || moments.length === 0) return [];

  const texts = moments.map((m) => m.raw_text || '');
  const embeddings = await embedBatch(texts, 500);
  const validEmbeddings = embeddings.map((e, i) => ({ index: i, embedding: e }));

  if (validEmbeddings.length === 0) {
    return moments.map((m) => ({
      seedMoment: m,
      members: [m],
      ids: [m.moment_id],
      text: m.raw_text
    }));
  }

  const clusters = [];
  const assigned = new Set();

  for (const seed of validEmbeddings) {
    if (assigned.has(seed.index)) continue;

    const clusterMembers = [seed];
    assigned.add(seed.index);

    for (const candidate of validEmbeddings) {
      if (assigned.has(candidate.index)) continue;

      const similarity = cosineSimilarity(seed.embedding, candidate.embedding);
      if (similarity >= CLUSTER_SIM_THRESHOLD) {
        clusterMembers.push(candidate);
        assigned.add(candidate.index);
      }
    }

    const clusterMoments = clusterMembers.map((cm) => moments[cm.index]);
    clusters.push({
      seedMoment: moments[seed.index],
      members: clusterMembers,
      ids: clusterMoments.map((m) => m.moment_id),
      texts: clusterMoments.map((m) => m.raw_text)
    });
  }

  return clusters;
}

module.exports = { clusterMoments };
