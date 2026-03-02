const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "so", "for", "to", "of", "in", "on", "at",
  "by", "from", "with", "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "that",
  "this", "these", "those", "you", "your", "we", "our", "they", "their", "he", "she", "his", "her", "them",
  "i", "me", "my", "mine", "us", "about", "into", "over", "under", "up", "down", "out", "off", "not", "no",
  "yes", "do", "does", "did", "done", "have", "has", "had", "can", "could", "will", "would", "should", "may",
  "might", "must", "also", "just", "new", "get", "got", "how", "what", "when", "where", "why", "who", "which"
]);

function toErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stemToken(token) {
  let result = token;
  const suffixes = ["ingly", "edly", "ing", "edly", "edly", "ed", "ies", "es", "s"];
  for (const suffix of suffixes) {
    if (result.length > 4 && result.endsWith(suffix)) {
      if (suffix === "ies") {
        result = `${result.slice(0, -3)}y`;
      } else {
        result = result.slice(0, -suffix.length);
      }
      break;
    }
  }
  return result;
}

function tokenize(text) {
  return cleanText(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !STOPWORDS.has(token))
    .map(stemToken)
    .filter((token) => token.length >= 2);
}

function buildTf(tokens) {
  const tf = new Map();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  const max = Math.max(...tf.values(), 1);
  for (const [token, count] of tf.entries()) {
    tf.set(token, count / max);
  }

  return tf;
}

function buildIdf(tokenLists) {
  const docCount = tokenLists.length;
  const df = new Map();

  for (const tokens of tokenLists) {
    const unique = new Set(tokens);
    for (const token of unique) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [token, freq] of df.entries()) {
    idf.set(token, Math.log((docCount + 1) / (freq + 1)) + 1);
  }

  return idf;
}

function buildTfidfVectors(tokenLists) {
  const idf = buildIdf(tokenLists);
  const vectors = [];

  for (const tokens of tokenLists) {
    const tf = buildTf(tokens);
    const vector = new Map();
    for (const [token, tfValue] of tf.entries()) {
      vector.set(token, tfValue * (idf.get(token) || 0));
    }
    vectors.push(vector);
  }

  return { vectors, idf };
}

function cosineSimilaritySparse(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const value of a.values()) {
    normA += value * value;
  }
  for (const value of b.values()) {
    normB += value * value;
  }

  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [token, value] of small.entries()) {
    dot += value * (large.get(token) || 0);
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function cosineSimilarityDense(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function averageSimilarityToCluster(candidateIdx, clusterIndices, similarityMatrix) {
  if (!clusterIndices.length) {
    return 0;
  }

  let total = 0;
  for (const idx of clusterIndices) {
    total += similarityMatrix[candidateIdx][idx] || 0;
  }
  return total / clusterIndices.length;
}

function greedyThresholdCluster(items, similarityMatrix, threshold) {
  const assigned = new Set();
  const clusters = [];

  for (let i = 0; i < items.length; i += 1) {
    if (assigned.has(i)) {
      continue;
    }

    const cluster = [i];
    assigned.add(i);

    let changed = true;
    while (changed) {
      changed = false;

      for (let j = 0; j < items.length; j += 1) {
        if (assigned.has(j)) {
          continue;
        }

        const avg = averageSimilarityToCluster(j, cluster, similarityMatrix);
        if (avg >= threshold) {
          cluster.push(j);
          assigned.add(j);
          changed = true;
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

function buildSimilarityMatrixSparse(vectors) {
  const matrix = vectors.map(() => vectors.map(() => 0));
  for (let i = 0; i < vectors.length; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < vectors.length; j += 1) {
      const score = cosineSimilaritySparse(vectors[i], vectors[j]);
      matrix[i][j] = score;
      matrix[j][i] = score;
    }
  }
  return matrix;
}

function buildSimilarityMatrixDense(vectors) {
  const matrix = vectors.map(() => vectors.map(() => 0));
  for (let i = 0; i < vectors.length; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < vectors.length; j += 1) {
      const score = cosineSimilarityDense(vectors[i], vectors[j]);
      matrix[i][j] = score;
      matrix[j][i] = score;
    }
  }
  return matrix;
}

function topKeywordsForCluster(clusterIndices, tokenLists, idf, limit = 3) {
  const scores = new Map();

  for (const idx of clusterIndices) {
    const tf = buildTf(tokenLists[idx]);
    for (const [token, tfValue] of tf.entries()) {
      const idfValue = idf.get(token) || 0;
      const boost = token.length > 3 ? 1.15 : 1;
      scores.set(token, (scores.get(token) || 0) + tfValue * idfValue * boost);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function keywordLabel(clusterIndices, documents, tokenLists, idf) {
  const words = topKeywordsForCluster(clusterIndices, tokenLists, idf, 3);
  if (words.length) {
    return words.join(" ");
  }

  const fallback = documents[clusterIndices[0]]?.title || documents[clusterIndices[0]]?.domain || "Similar Tabs";
  return String(fallback).slice(0, 60);
}

function isValidHttpsOrLocalhost(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch (_err) {
    return false;
  }
}

async function fetchEmbeddings(endpoint, apiKey, texts) {
  if (!isValidHttpsOrLocalhost(endpoint)) {
    throw new Error("Embeddings endpoint must be https:// (or localhost). ");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ texts })
  });

  if (!response.ok) {
    throw new Error(`Embeddings API request failed (${response.status}).`);
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.embeddings)) {
    throw new Error("Embeddings API response missing embeddings array.");
  }

  return payload.embeddings;
}

async function fetchAiLabel(endpoint, apiKey, clusterTexts) {
  const labelEndpoint = endpoint.endsWith("/") ? `${endpoint}label` : `${endpoint}/label`;
  if (!isValidHttpsOrLocalhost(labelEndpoint)) {
    return null;
  }

  const response = await fetch(labelEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      texts: clusterTexts.slice(0, 4),
      instruction: "Return a short 2-4 word topic label."
    })
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const label = cleanText(payload?.label || payload?.text || payload?.result || "");
  return label ? label.slice(0, 60) : null;
}

async function clusterLocal(documents, threshold) {
  const tokenLists = documents.map((doc) => tokenize(doc.text));
  const { vectors, idf } = buildTfidfVectors(tokenLists);
  const matrix = buildSimilarityMatrixSparse(vectors);
  const indexClusters = greedyThresholdCluster(documents, matrix, threshold);

  const clusters = indexClusters.map((indices) => ({
    tabIds: indices.map((idx) => documents[idx].tabId),
    label: keywordLabel(indices, documents, tokenLists, idf)
  }));

  return { clusters, warnings: [] };
}

async function clusterEmbeddings(documents, settings) {
  const embeddings = await fetchEmbeddings(settings.embeddingsEndpoint, settings.embeddingsApiKey, documents.map((d) => d.text));

  if (embeddings.length !== documents.length) {
    throw new Error("Embeddings count does not match tab document count.");
  }

  const matrix = buildSimilarityMatrixDense(embeddings);
  const indexClusters = greedyThresholdCluster(documents, matrix, settings.embeddingsThreshold);

  const tokenLists = documents.map((doc) => tokenize(doc.text));
  const { idf } = buildTfidfVectors(tokenLists);

  const warnings = [];
  const clusters = [];

  for (const indices of indexClusters) {
    let label = keywordLabel(indices, documents, tokenLists, idf);

    if (settings.aiLabeling) {
      try {
        const aiLabel = await fetchAiLabel(
          settings.embeddingsEndpoint,
          settings.embeddingsApiKey,
          indices.map((idx) => documents[idx].text)
        );
        if (aiLabel) {
          label = aiLabel;
        }
      } catch (_err) {
        warnings.push("AI labeling failed for one cluster; used keyword label instead.");
      }
    }

    clusters.push({
      tabIds: indices.map((idx) => documents[idx].tabId),
      label
    });
  }

  return { clusters, warnings };
}

async function handleClusterRequest(payload) {
  const documents = Array.isArray(payload?.documents)
    ? payload.documents.filter((doc) => doc && typeof doc.tabId === "number" && cleanText(doc.text))
    : [];

  const settings = payload?.settings || {};

  if (documents.length < 2) {
    return {
      clusters: documents.map((doc) => ({ tabIds: [doc.tabId], label: doc.domain || "Tab" })),
      warnings: ["Not enough valid tab documents for semantic clustering."]
    };
  }

  if (settings.similarityMode === "embeddings") {
    return clusterEmbeddings(documents, settings);
  }

  return clusterLocal(documents, settings.localThreshold);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action !== "OFFSCREEN_CLUSTER") {
    return;
  }

  (async () => {
    const result = await handleClusterRequest(message.payload || {});
    sendResponse({ ok: true, result });
  })().catch((err) => {
    sendResponse({ ok: false, error: toErrorMessage(err) });
  });

  return true;
});
