const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const EMBEDDINGS_BATCH_SIZE = 50;

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function tokenize(text) {
  return cleanText(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
    .filter((word) => !STOPWORDS.has(word));
}

function computeTf(tokens) {
  const tf = new Map();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  const maxCount = Math.max(...tf.values(), 1);
  for (const [token, count] of tf.entries()) {
    tf.set(token, count / maxCount);
  }

  return tf;
}

function computeIdf(tokenLists) {
  const docCount = tokenLists.length;
  const docFreq = new Map();

  for (const tokens of tokenLists) {
    for (const token of new Set(tokens)) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [token, freq] of docFreq.entries()) {
    idf.set(token, Math.log((docCount + 1) / (freq + 1)) + 1);
  }

  return idf;
}

function keywordLabelFromTitles(clusterIndices, docs) {
  const titleTokens = clusterIndices.map((idx) => tokenize(docs[idx].title || ""));
  const idf = computeIdf(titleTokens.length ? titleTokens : [[]]);
  const scores = new Map();

  for (const tokens of titleTokens) {
    const tf = computeTf(tokens);
    for (const [token, tfVal] of tf.entries()) {
      scores.set(token, (scores.get(token) || 0) + tfVal * (idf.get(token) || 0));
    }
  }

  const top = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([token]) => token);

  if (top.length) {
    return top.join(" ");
  }

  const first = docs[clusterIndices[0]];
  return cleanText(first?.domain || first?.title || "Similar Tabs").slice(0, 60) || "Similar Tabs";
}

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || !vecA.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i += 1) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildSimilarityMatrix(vectors) {
  const matrix = vectors.map(() => vectors.map(() => 0));

  for (let i = 0; i < vectors.length; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < vectors.length; j += 1) {
      const score = cosineSimilarity(vectors[i], vectors[j]);
      matrix[i][j] = score;
      matrix[j][i] = score;
    }
  }

  return matrix;
}

function clusterGreedyAnyLink(similarityMatrix, threshold) {
  const total = similarityMatrix.length;
  const assigned = new Set();
  const clusters = [];

  for (let i = 0; i < total; i += 1) {
    if (assigned.has(i)) {
      continue;
    }

    const cluster = [i];
    assigned.add(i);

    let changed = true;
    while (changed) {
      changed = false;

      for (let candidate = 0; candidate < total; candidate += 1) {
        if (assigned.has(candidate)) {
          continue;
        }

        const closeToAny = cluster.some((member) => similarityMatrix[candidate][member] >= threshold);
        if (closeToAny) {
          cluster.push(candidate);
          assigned.add(candidate);
          changed = true;
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

async function fetchEmbeddingBatch(apiKey, model, inputs) {
  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: inputs
    })
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`OpenAI embeddings failed (${response.status})${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("OpenAI embeddings response missing data array.");
  }

  const ordered = payload.data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => item.embedding);

  if (ordered.length !== inputs.length || ordered.some((e) => !Array.isArray(e))) {
    throw new Error("OpenAI embeddings response shape is invalid.");
  }

  return ordered;
}

async function fetchOpenAIEmbeddings(apiKey, model, texts) {
  const vectors = [];

  for (let i = 0; i < texts.length; i += EMBEDDINGS_BATCH_SIZE) {
    const chunk = texts.slice(i, i + EMBEDDINGS_BATCH_SIZE);
    const chunkVectors = await fetchEmbeddingBatch(apiKey, model, chunk);
    vectors.push(...chunkVectors);
  }

  return vectors;
}

function parseResponsesOutput(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (Array.isArray(payload?.output)) {
    const parts = [];
    for (const out of payload.output) {
      if (!Array.isArray(out?.content)) {
        continue;
      }
      for (const piece of out.content) {
        if (piece?.type === "output_text" && typeof piece.text === "string") {
          parts.push(piece.text);
        }
        if (piece?.type === "text" && typeof piece?.text?.value === "string") {
          parts.push(piece.text.value);
        }
      }
    }

    const text = parts.join(" ").trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeLabel(raw) {
  const compact = cleanText(raw)
    .replace(/["'`]/g, "")
    .replace(/[^a-zA-Z0-9\s&/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!compact) {
    return "";
  }

  const words = compact.split(" ").slice(0, 4);
  return words.join(" ").slice(0, 60);
}

async function generateClusterLabelWithOpenAI(apiKey, docs, clusterIndices) {
  const lines = clusterIndices
    .slice(0, 8)
    .map((idx) => `- ${cleanText(docs[idx].title || "Untitled")} (${cleanText(docs[idx].domain || "unknown")})`)
    .join("\n");

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      max_output_tokens: 20,
      input: [
        {
          role: "system",
          content: "Return only a concise 2-4 word topic label for a browser tab cluster. No punctuation unless essential."
        },
        {
          role: "user",
          content: `Cluster tabs:\n${lines}`
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI labeling failed (${response.status}).`);
  }

  const payload = await response.json();
  return normalizeLabel(parseResponsesOutput(payload));
}

async function embedAndCluster(payload) {
  const docs = Array.isArray(payload?.docs) ? payload.docs : [];
  const model = ["text-embedding-3-small", "text-embedding-3-large"].includes(payload?.model)
    ? payload.model
    : "text-embedding-3-small";
  const apiKey = cleanText(payload?.apiKey || "");
  const threshold = clamp(Number(payload?.threshold || 0.82), 0.5, 0.98);
  const aiLabeling = Boolean(payload?.aiLabeling);

  if (!apiKey) {
    throw new Error("OpenAI API key is required.");
  }

  if (docs.length < 2) {
    return {
      clusters: docs.map((d) => ({ tabIds: [d.tabId], label: d.domain || "Tab" })),
      stats: { candidates: docs.length, clusters: docs.length, eligible: 0 },
      warnings: ["Not enough tabs for AI grouping."],
      errors: []
    };
  }

  const texts = docs.map((doc) => cleanText(doc.text));
  const vectors = await fetchOpenAIEmbeddings(apiKey, model, texts);
  const matrix = buildSimilarityMatrix(vectors);
  const clusterIndices = clusterGreedyAnyLink(matrix, threshold);

  const warnings = [];
  const clusters = [];

  for (const indices of clusterIndices) {
    let label = keywordLabelFromTitles(indices, docs);

    if (aiLabeling && indices.length >= 2) {
      try {
        const aiLabel = await generateClusterLabelWithOpenAI(apiKey, docs, indices);
        if (aiLabel) {
          label = aiLabel;
        }
      } catch (_err) {
        warnings.push("AI labeling failed for one cluster; used keyword label.");
      }
    }

    clusters.push({
      tabIds: indices.map((idx) => docs[idx].tabId),
      label: label || "Similar Tabs"
    });
  }

  return {
    clusters,
    stats: {
      candidates: docs.length,
      clusters: clusters.length,
      eligible: clusters.filter((c) => c.tabIds.length >= 2).length
    },
    warnings,
    errors: []
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "EMBED_AND_CLUSTER") {
    return;
  }

  (async () => {
    const result = await embedAndCluster(message.payload || {});
    sendResponse({ ok: true, result });
  })().catch((err) => {
    sendResponse({ ok: false, error: toErrorMessage(err) });
  });

  return true;
});
