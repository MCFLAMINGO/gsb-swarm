/**
 * lib/nvim.js — NVIDIA NIM inference wrapper
 * Drop-in replacement for Anthropic claude-haiku calls.
 * Uses OpenAI-compatible API at build.nvidia.com (free tier, 40 RPM).
 *
 * Usage:
 *   const { nvimChat, nvimClient } = require('./lib/nvim');
 *   const text = await nvimChat(systemPrompt, userPrompt, maxTokens);
 */

'use strict';

const OpenAI = require('openai');

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL    = 'meta/llama-3.3-70b-instruct'; // free, 40 RPM
const NVIDIA_API_KEY  = process.env.NVIDIA_API_KEY;    // set in Railway env

let _client = null;

function getNvimClient() {
  if (!_client) {
    if (!NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY not set in environment');
    _client = new OpenAI({ apiKey: NVIDIA_API_KEY, baseURL: NVIDIA_BASE_URL });
  }
  return _client;
}

/**
 * nvimChat — main call, returns string
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens  default 800
 * @returns {Promise<string>}
 */
async function nvimChat(systemPrompt, userPrompt, maxTokens = 800) {
  const client = getNvimClient();
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  const completion = await client.chat.completions.create({
    model: NVIDIA_MODEL,
    messages,
    max_tokens: maxTokens,
    temperature: 0.7,
  });
  return completion.choices[0]?.message?.content?.trim() || '';
}

/**
 * isReady — true if NVIDIA_API_KEY is set
 */
function isReady() {
  return Boolean(NVIDIA_API_KEY);
}

module.exports = { nvimChat, getNvimClient, isReady };
