# Infrastructure

Repos & URLs, Railway services + IDs, Vercel projects, git push commands, env vars list (no values), admin endpoints, admin token.

## Repos & URLs

| App | Production URL | GitHub | Branch |
|---|---|---|---|
| GSB Swarm Backend | gsb-swarm-production.up.railway.app | MCFLAMINGO/gsb-swarm | main |
| LocalIntel Landing | www.thelocalintel.com | MCFLAMINGO/localintel-landing | main |
| Dashboard (INTERNAL) | swarm-deploy-throw.vercel.app | MCFLAMINGO/gsb-swarm-dashboard | main |

---

## Infrastructure

### Railway (Backend)
- Node.js / Express — `dashboard-server.js` is the main entry point
- Postgres: `postgresql://postgres:mHNhBVhHmYVQdPAKVuysgjpajxzneqkE@turntable.proxy.rlwy.net:25739/railway`
- Admin migration token: `localintel-migrate-2026`
- `db.query()` returns array directly — NEVER use `.rows`
- `pos_type` is NOT a column — always use `pos_config->>'pos_type'`

### Vercel (Landing)
- **CANONICAL PROJECT: `gsb-swarm-dashboard`** → this is the project mapped to `www.thelocalintel.com`
- **CANONICAL REPO: `MCFLAMINGO/localintel-landing`** → connected to `gsb-swarm-dashboard`
- **DEPLOY METHOD: Git push to `localintel-landing` main — Vercel auto-deploys. NO CLI DEPLOYS NEEDED.**
- **NEVER use `--name swarm-deploy-throw` or any other project name — that is wrong and creates junk deployments**
- **NEVER create a new Vercel project — there are already too many orphan projects**
- orgId: `team_19iu8EDRFBkTdrRtK7s6oYuE`
- If a manual redeploy is ever needed: go to vercel.com/mcflamingos-projects/gsb-swarm-dashboard/deployments and click Redeploy on the latest deployment

### Git Push Commands
- gsb-swarm: `HOME=/home/user GIT_CONFIG_GLOBAL=/home/user/.gitconfig-proxy git push origin main` with `api_credentials=["github"]`
- localintel-landing: same pattern

---

## Railway Environment Variables (SET — no values stored here)

| Key | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio REST API (Console — never commit) |
| `TWILIO_AUTH_TOKEN` | Twilio REST API (secret — Console only, never commit) |
| `TWILIO_FROM_NUMBER` | `+19045067476` / (904) 506-7476 — outbound SMS + calls |
| `TWILIO_MESSAGING_SERVICE_SID` | `MG01ab31b68291d60514f7cb6af98f5a57` — A2P Messaging Service |
| `TWILIO_CAMPAIGN_SID` | `CMdde30606a066ea5d5c2a4abe6dbd4339` — A2P Campaign (CUSTOMER_CARE, approved 2026-07-20) |
| `TWILIO_BRAND_SID` | `BN0a864697b432e6be3551efe69b9bb064` — A2P Brand Registration |
| `RESEND_API_KEY` | Resend email — send + inbound |
| `OWNER_ALERT_PHONE` | Erik's phone for alerts (fallback: +19045867887) |
| `VOICE_CALLER_KEY` | Legacy voice-intake key (now unused — rfqBroadcast handles it) |
| `RAILWAY_PUBLIC_DOMAIN` | Used by rfqCallback.js for TwiML URLs |
| `VIRTUALS_API_KEY_WALLET_PROFILER` | GSB Wallet Profiler + DCA Engine (agent 1333) — Virtuals Compute |
| `VIRTUALS_API_KEY_CEO` | GSB CEO (agent 1332) — Virtuals Compute |
| `VIRTUALS_API_KEY_ALPHA_SCANNER` | GSB Alpha Scanner (agent 1334) — Virtuals Compute |
| `VIRTUALS_API_KEY_TOKEN_ANALYST` | GSB Token Analyst (agent 1335) — Virtuals Compute |
| `VIRTUALS_API_KEY_THREAD_WRITER` | GSB Thread Writer (agent 1336) — Virtuals Compute |

---

## Third-Party Integrations

### Virtuals Compute (NEW — replaces old Privy JWT auth as of 2026-05-01)
- Base URL: `https://compute.virtuals.io/v1`
- Auth: `x-api-key: $VIRTUALS_API_KEY` (NOT Bearer token)
- OpenAI-compatible: `POST /v1/chat/completions` with `Authorization: Bearer $VIRTUALS_API_KEY`
- Anthropic-compatible: `POST /v1/messages` with `x-api-key: $VIRTUALS_API_KEY` + `anthropic-version: 2023-06-01`
- Available models: `anthropic/claude-sonnet-4-5`, `moonshotai/kimi-k2-0905`
- Old vars OBSOLETE: `VIRTUALS_PRIVY_TOKEN`, `VIRTUALS_PRIVY_REFRESH_TOKEN` — delete from Railway
- `acpAuth.js` will be rewritten to use per-agent keys once all keys are added by Erik
- Per-agent keys being added to Railway (Erik adding manually):
  - `VIRTUALS_API_KEY_CEO` — agent 1332 | Base Builder Code: `bc_qhc9o1lh` | Compute billing: FUNDED (2026-05-01)
    - Agent UUID: `019d7568-cd41-7523-9538-e501cc1875cc` | Created: 2026-04-09
    - EVM wallet: `0xb165a3b019eb1922f5dcda97b83be75484b30d27`
    - SOL wallet: `2XZYfpH6nSYL53C45RiNrCfkHr3LjSsrFxUgRcMc64Da`
    - Agent Token (GSB): `0x8E223841aA396d36a6727EfcEAFC61d691692a37` — tokenized
    - Wallet ID: `rrbxvrk8a6d8nb1tz9qdp76b`
    - Signer public key: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEOloZLpdqX/gEW3gBAj4hAUQcFzbiFgEZ49Lb5WgvTH7Yb6IKd3vzCu41Sp+vtJA4UXwBYEz3p19EmLFRrqSNlg==`
  - `VIRTUALS_API_KEY_WALLET_PROFILER` — agent 1333 | Base Builder Code: `bc_7vtueq99`
    - Agent UUID: `019d756c-9eba-7600-81ba-f1c78f43277c` | Created: 2026-04-09
    - EVM wallet: `0xeb6447a8b44837458f391e2bac39990daf6bd522`
    - SOL wallet: `2CXT27mSGkriGmM5YtXZJ1HvkMxHNBgjpMArvfMzpn9m`
    - Wallet ID: `d3w35d9gcl1ll7bvdw1bx8b1`
    - Signer public key: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJVQtuRhQu2cgoT1zXk15viuU5Swy5oz/U/VVGv6JfJbcmDidbkliBeXeTz2wG/5NUHqHT4yivE9b9MIK4bVm7g==`
  - `VIRTUALS_API_KEY_ALPHA_SCANNER` — agent 1334 | Base Builder Code: `bc_5fdaj3ka`
    - Agent UUID: `019d755e-dfd0-7b6c-8b4c-21cfbe6fda1c` | Created: 2026-04-09
    - EVM wallet: `0x9d23bf7e4084e278a06c85e299a8ed5db3d663b5`
    - SOL wallet: `28v6FbWMkdv224cV3TS2brTdHK5LYAdmjFm6GUcQg23S`
    - Wallet ID: `gmk5zp1h21qq8ev4tlnv2nba`
    - Signer public key: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgKmR3QYy1aSj/42gHczjAoyuNA0Yp0ID3cT1rYkrlHkw8ZfWlaqvkc5AT8KeyWZhv5939h2txw8MhcTNc7xAWg==`
  - `VIRTUALS_API_KEY_TOKEN_ANALYST` — agent 1335 | Base Builder Code: `bc_hmt1owql`
    - Agent UUID: `019d756b-0217-7252-8094-7854afde1703` | Created: 2026-04-09
    - EVM wallet: `0x489a9d6c79957906540491a493a7a4d13ad0701a`
    - SOL wallet: `72W8cHsa6VSTcaWBWAnYZutH59CfP62xKK8zvwwB4XAo`
    - Wallet ID: `u0sqfq4gtr3ouz2o8bddgg81`
    - Signer public key: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQU/xmKDe9tNITxF1wkdcqHwAaE7LbZEQCry6q2peSavGNKdRiA+Qjy1lo6d3fVImzXA1kr5+VVFdZpobQL6L3g==`
  - `VIRTUALS_API_KEY_THREAD_WRITER` — agent 1336 | Base Builder Code: `bc_40rvhwqs`
    - Agent UUID: `019d7565-5b56-778e-8550-66ec4b179a81` | Created: 2026-04-09
    - EVM wallet: `0x2c281b4ba71e79dd91e3a9d78ed5348bc5774df9`
    - SOL wallet: `EJkaqQ2Z1mRQDJ2LMpiieaLFt7kqpSHcZSNXD5uV7SnX`
    - Wallet ID: `n83xb0y9gqm919ygu0trusm8`
    - Signer public key: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEE8USEW4pWdqfupJJ+qQqmkCTTqdhANbCNSRu134A/UtUSUb1DIlSGOMJpMPIdLaocAPvruGBumkcM3llR4N1tw==`

### Twilio
- Voice number: **(904) 506-7476**
- Inbound voice webhook: `POST https://gsb-swarm-production.up.railway.app/api/voice/incoming`
- After Gather: `POST /api/voice/process`
- **PENDING SETUP:** SMS inbound webhook needs to be set in Twilio console to:
  `POST https://gsb-swarm-production.up.railway.app/api/rfq/sms-inbound`
  (Currently only voice is wired — SMS replies from providers won't work until this is set)
- Outbound callback calls: `POST /api/rfq/callback-twiml` (GET) + `/api/rfq/callback-process` (POST)
- Voice: `Polly.Joanna-Neural` everywhere

### Resend
- Domain: thelocalintel.com — verified, region us-east-1, registered on Namecheap
- Outbound: `jobs@thelocalintel.com` → providers get broadcast emails
- Reply-to encoding: `jobs+JOBCODE@thelocalintel.com` (e.g. `jobs+X4R9QW@thelocalintel.com`)
- DKIM: TXT record `resend._domainkey` — already set
- SPF: MX record `send` → `feedback-smtp.us-east-1.amazonses.com` priority 10 — already set
- Inbound MX: ✅ LIVE — `10 inbound-smtp.us-east-1.amazonaws.com` confirmed via dig (2026-05-02)
- Resend receiving: ✅ ENABLED — domain thelocalintel.com receiving active
- Resend webhook: ✅ LIVE — `email.received` → `https://gsb-swarm-production.up.railway.app/api/rfq/email-inbound` (enabled 2026-05-02)
- Inbound webhook: `POST /api/rfq/email-inbound` — extracts job code from To address

