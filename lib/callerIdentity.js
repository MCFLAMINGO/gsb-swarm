'use strict';
/**
 * callerIdentity.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Wallet-agnostic caller identity for LocalIntel.
 *
 * Every caller is identified by phone number (from Twilio).
 * Over time they can attach:
 *   - name         (captured from voice)
 *   - email        (confirmed via SMS reply — not just voice parse)
 *   - wallet       (any chain: Tempo, Base, Solana, or their own)
 *   - agent_key    (for AI agents / MCP clients calling programmatically)
 *
 * Email confirmation flow:
 *   1. Voice parses email → store as email_pending
 *   2. SMS sent: "We heard your email as X — reply CONFIRM or reply with correct address"
 *   3. On CONFIRM or a new email address reply → promote to email (confirmed)
 *
 * Wallet policy:
 *   - wallet_address can be ANY chain address (no lock-in)
 *   - wallet_chain: 'tempo' | 'base' | 'solana' | 'other'
 *   - wallet_provisioned: true if LocalIntel created it for them
 *   - They can update at any time by texting: WALLET 0x...
 *
 * Postgres is king — all identity state lives here.
 */

const db = require('./db');

let migrated = false;
async function migrate() {
  if (migrated) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS caller_identities (
      phone              TEXT PRIMARY KEY,
      name               TEXT,
      email              TEXT,            -- confirmed email
      email_pending      TEXT,            -- voice-parsed, awaiting confirmation
      zip                TEXT,
      wallet_address     TEXT,            -- any chain
      wallet_chain       TEXT,            -- 'tempo'|'base'|'solana'|'other'
      wallet_provisioned BOOLEAN NOT NULL DEFAULT FALSE,
      agent_key          TEXT,            -- for AI agent callers
      rfq_count          INT  NOT NULL DEFAULT 0,
      order_count        INT  NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  migrated = true;
}

// ── getOrCreate ───────────────────────────────────────────────────────────────
/**
 * Get or create identity for a phone number.
 * Always updates last_seen.
 */
async function getOrCreate(phone) {
  await migrate();
  if (!phone || phone === 'unknown') return null;

  // Upsert — touch last_seen on every call
  await db.query(
    `INSERT INTO caller_identities (phone)
     VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET last_seen = NOW()`,
    [phone]
  );
  const rows = await db.query(
    `SELECT * FROM caller_identities WHERE phone = $1`,
    [phone]
  );
  return rows[0] || null;
}

// ── update ────────────────────────────────────────────────────────────────────
/**
 * Update any fields on an identity.
 * Only provided (non-undefined) fields are changed.
 */
async function update(phone, patch) {
  await migrate();
  const allowed = ['name','email','email_pending','zip','wallet_address','wallet_chain',
                   'wallet_provisioned','agent_key','rfq_count','order_count'];
  const fields = [];
  const vals   = [];
  let   i      = 1;
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = $${i++}`);
      vals.push(patch[key]);
    }
  }
  if (!fields.length) return;
  fields.push(`last_seen = NOW()`);
  vals.push(phone);
  await db.query(
    `UPDATE caller_identities SET ${fields.join(', ')} WHERE phone = $${i}`,
    vals
  );
}

// ── captureFromVoice ──────────────────────────────────────────────────────────
/**
 * Called at end of every voice interaction.
 * Stores name + zip if captured, increments rfq_count or order_count.
 * Does NOT store unconfirmed email directly — stores as email_pending and sends
 * a confirmation SMS.
 */
async function captureFromVoice({ phone, name, zip, emailGuess, type = 'rfq' }) {
  await migrate();
  const identity = await getOrCreate(phone);
  if (!identity) return null;

  const patch = {};
  if (name && !identity.name) patch.name = name;
  if (zip  && !identity.zip)  patch.zip  = zip;
  if (type === 'rfq')   patch.rfq_count   = (identity.rfq_count   || 0) + 1;
  if (type === 'order') patch.order_count = (identity.order_count || 0) + 1;

  // Email from voice is unreliable — store as pending, confirm via SMS
  if (emailGuess && emailGuess !== identity.email) {
    patch.email_pending = emailGuess;
    // Send confirmation SMS
    const { sendSms } = require('./rfqBroadcast');
    await sendSms(
      phone,
      `LocalIntel: We heard your email as ${emailGuess}. ` +
      `Reply CONFIRM to save it, or reply with the correct address.`
    ).catch(() => {});
  }

  if (Object.keys(patch).length) await update(phone, patch);
  return getOrCreate(phone);
}

// ── confirmEmail ──────────────────────────────────────────────────────────────
/**
 * Called when caller replies CONFIRM or with a corrected email address.
 * Promotes email_pending → email (or saves the correction directly).
 */
async function confirmEmail(phone, confirmedEmail) {
  await migrate();
  const identity = await getOrCreate(phone);
  if (!identity) return null;

  const email = confirmedEmail && confirmedEmail.includes('@')
    ? confirmedEmail.trim().toLowerCase()
    : identity.email_pending;

  if (!email) return identity;

  await update(phone, { email, email_pending: null });
  console.log(`[callerIdentity] Email confirmed for ${phone}: ${email}`);
  return getOrCreate(phone);
}

// ── attachWallet ──────────────────────────────────────────────────────────────
/**
 * Attach any wallet address to a caller identity.
 * wallet_chain is inferred from address format if not provided:
 *   0x...  (40 hex chars) → 'base' or 'tempo' (default 'base' unless specified)
 *   else   → 'other'
 *
 * Called when:
 *   - Caller texts "WALLET 0xABCD..."
 *   - Agent authenticates with a wallet
 *   - LocalIntel provisions a wallet for them
 */
async function attachWallet(phone, walletAddress, { chain, provisioned = false } = {}) {
  await migrate();
  let walletChain = chain;
  if (!walletChain) {
    if (/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      walletChain = 'base'; // EVM default — caller can override
    } else {
      walletChain = 'other';
    }
  }
  await update(phone, {
    wallet_address:     walletAddress,
    wallet_chain:       walletChain,
    wallet_provisioned: provisioned,
  });
  console.log(`[callerIdentity] Wallet attached to ${phone}: ${walletAddress} (${walletChain})`);
}

// ── parseSmsCommand ───────────────────────────────────────────────────────────
/**
 * Parse inbound SMS from a known caller phone.
 * Returns a structured command object.
 *
 * Recognized patterns:
 *   CONFIRM              → confirm pending email
 *   CONFIRM email@x.com  → confirm with correction
 *   WALLET 0x...         → attach wallet
 *   YES-CODE             → RFQ bid (handled by rfq webhook, not here)
 *   1 / 2 / 3            → RFQ selection reply (handled by rfq webhook)
 */
function parseSmsCommand(body) {
  const text = (body || '').trim();
  const lower = text.toLowerCase();

  // Email confirmation
  if (/^confirm$/i.test(text)) return { cmd: 'confirm_email', email: null };
  if (/^confirm\s+\S+@\S+/i.test(text)) {
    const m = text.match(/^confirm\s+(\S+@\S+)/i);
    return { cmd: 'confirm_email', email: m ? m[1].toLowerCase() : null };
  }
  // Bare email address (looks like an email) — treat as correction
  if (/^\S+@\S+\.\S+$/.test(text)) return { cmd: 'confirm_email', email: text.toLowerCase() };

  // Wallet attachment
  if (/^wallet\s+/i.test(text)) {
    const m = text.match(/^wallet\s+(\S+)/i);
    return { cmd: 'attach_wallet', address: m ? m[1] : null };
  }

  // RFQ YES reply
  const yesMatch = text.match(/^YES[-\s]([A-Z0-9]{5,8})/i);
  if (yesMatch) return { cmd: 'rfq_yes', code: yesMatch[1].toUpperCase() };

  // RFQ selection (1/2/3)
  if (/^[1-5]$/.test(text)) return { cmd: 'rfq_select', index: parseInt(text) };

  // STOP / UNSUBSCRIBE
  if (/^(stop|unsubscribe|cancel|quit|end)$/i.test(text)) return { cmd: 'unsubscribe' };

  return { cmd: 'unknown', raw: text };
}

module.exports = { getOrCreate, update, captureFromVoice, confirmEmail, attachWallet, parseSmsCommand };
