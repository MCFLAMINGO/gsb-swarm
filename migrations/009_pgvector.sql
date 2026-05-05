-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to businesses table
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS embedding vector(768);

-- Index for similarity search (cosine distance)
-- Only create after backfill — commented out for now, Session B will add it
-- CREATE INDEX IF NOT EXISTS idx_businesses_embedding ON businesses USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
