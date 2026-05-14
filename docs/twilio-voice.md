# Twilio Voice + SMS

Twilio SMS + voice, voiceIntake.js, conversation threading (B41), call transcripts, recording, sms_query_log, intent_dead_ends.

## Access Point: Twilio (Architecture Canon)

#### 3. Twilio (`POST /api/local-intel` + voice)
**Who:** Regular customers — SMS and voice. No app required.
**What it is:** The human UX for task routing. A customer texts "I need a landscaper in 32082" or calls the Twilio number and says it. Same routing logic as MCP — intentRouter → category → businesses → RFQ dispatch. SMS log in `sms_query_log`. Voice transcripts in `call_transcripts`. Dead ends in `intent_dead_ends`.
**Positioning:** Like a Telegram bot but phone-native. No signup, no app, no login. Text or call → get routed → business gets the job.

## Messaging as Task Routing (Strategic Direction)

### Messaging as Task Routing (Strategic Direction — 2026-05-14)

SMS/voice via Twilio is currently implemented but underweighted in the product vision. The insight from session 2026-05-14:

**Messaging IS task routing.** The distinction between "sending a message" and "routing a task" is artificial at this layer. When someone texts "I need a plumber in Nocatee" they are not querying a database — they are initiating a workflow that ends with a confirmed booking and a payment. The message IS the task.

This positions LocalIntel closer to Telegram bots / WhatsApp Business / WeChat mini-programs than to Google Maps or Yelp. The difference: those platforms show you static listings. LocalIntel routes you to an actionable business node that can receive the job, respond with a quote, and get paid — all without a web app.

**Implication for future builds:**
- Twilio SMS should be treated as a first-class channel equal to MCP, not a secondary fallback
- Messaging threads (conversation state across multiple SMS turns) are more important than single-query resolution
- A business that has claimed their profile and set up tasks/menu items is findable AND actionable via message — this is the depth that matters
- Consider: WhatsApp Business API, iMessage for Business, or Telegram bot as additional messaging channels alongside Twilio
- `sms_query_log` + `call_transcripts` + `resolution_history` together = a full conversation layer. The next architectural move is threading these into stateful sessions per caller — not just individual query resolution.


---

## B41 — Conversation Threading

### B41 — Conversation Threading (SMS/Twilio Layer)
**Problem:** Each Twilio SMS query was stateless — no memory of prior ZIP, business, or intent. "That place" / "near here" / follow-up queries all failed.
**Fix:** Added `conversation_threads` table (migration 025). `lib/conversationThread.js` provides `getContext()` (loads last N turns, detects referential + zip-proxy patterns) and `appendTurn()` (fire-and-forget write). Injected into `localIntelAgent.js` POST handler: read before `resolveNlIntentFromRegistry`, write after each `res.json()` response path.
**Result:** SMS queries now carry thread context — ZIP resolved from history, referential business names resolved, follow-up intents enriched. Foundation for richer conversational routing.


---

## Voice-related sessions (B2, B3, B11, B16, B17, B18, B19, B20, B21, B22, B28)

See [session-log.md](session-log.md) for full B-series entries on voice/SMS layer including:
- B2 (follow-up state persistence)
- B3 (Reservation intent + cross-ZIP)
- B10 (Dead-end query logging)
- B11 (Call transcript logging)
- B16 (SMS query history)
- B17 (Voice recording REST fix)
- B18 (Voice loop "Anything else?")
- B19 (Food RFQ guard + V Pizza seed)
- B20 (voice Gather action URL fix)
- B21 (Voice search intercept + barbershop seeds)
- B22 (Call transcript enrichment + recording player)
- B28 (Fix recording_url construction)
- B41 (Conversation threading)

