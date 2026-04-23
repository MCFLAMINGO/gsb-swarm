#!/usr/bin/env python3
"""
embed_server.py
Lightweight Flask server that wraps sentence-transformers for local embedding.
Started automatically by embeddingWorker.js.
Zero external API calls. Model downloaded once (~80MB), cached in /tmp.
"""
import sys
import json
from flask import Flask, request, jsonify

app = Flask(__name__)
model = None

def load_model():
    global model
    if model is None:
        print('[embed-server] Loading all-MiniLM-L6-v2...', flush=True)
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer('all-MiniLM-L6-v2')
        print('[embed-server] Model ready', flush=True)
    return model

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'model': 'all-MiniLM-L6-v2'})

@app.route('/embed', methods=['POST'])
def embed():
    data  = request.get_json(force=True)
    texts = data.get('texts', [])
    if not texts:
        return jsonify({'vectors': [], 'dim': 0})
    m       = load_model()
    vectors = m.encode(texts, show_progress_bar=False).tolist()
    return jsonify({'vectors': vectors, 'dim': len(vectors[0]) if vectors else 0})

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    # Pre-load model on startup
    try:
        load_model()
    except Exception as e:
        print(f'[embed-server] Model load failed: {e}', flush=True)
    print(f'[embed-server] ready on port {port}', flush=True)
    app.run(host='127.0.0.1', port=port, debug=False, use_reloader=False)
