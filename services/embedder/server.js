import { pipeline } from '@xenova/transformers';
import express from 'express';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const MODEL = 'nomic-ai/nomic-embed-text-v1';

let embedder = null;

async function loadModel() {
  console.log('[embedder] Loading model:', MODEL);
  embedder = await pipeline('feature-extraction', MODEL, {
    quantized: true  // use quantized model — smaller, faster on CPU
  });
  console.log('[embedder] Model ready');
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: embedder ? 'ready' : 'loading', model: MODEL });
});

// Embed a single text string
app.post('/embed', async (req, res) => {
  if (!embedder) {
    return res.status(503).json({ error: 'model still loading' });
  }
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }
  try {
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data);
    res.json({ vector, dimensions: vector.length });
  } catch (err) {
    console.error('[embedder] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Embed a batch of texts
app.post('/embed-batch', async (req, res) => {
  if (!embedder) {
    return res.status(503).json({ error: 'model still loading' });
  }
  const { texts } = req.body;
  if (!Array.isArray(texts)) {
    return res.status(400).json({ error: 'texts array required' });
  }
  try {
    const vectors = await Promise.all(
      texts.map(async text => {
        const output = await embedder(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
      })
    );
    res.json({ vectors, dimensions: vectors[0]?.length ?? 0, count: vectors.length });
  } catch (err) {
    console.error('[embedder] batch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start
loadModel().then(() => {
  app.listen(PORT, () => console.log(`[embedder] Listening on port ${PORT}`));
}).catch(err => {
  console.error('[embedder] Fatal: model load failed:', err.message);
  process.exit(1);
});
