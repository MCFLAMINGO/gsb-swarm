# Twilio A2P 10DLC — Approved (2026-07-20)

**Status:** Approved and registered with carriers  
**Use case:** `CUSTOMER_CARE`  
**From number:** `(904) 506-7476` / `+19045067476`

## Resource IDs

| Resource | SID / value |
|---|---|
| Account | Set `TWILIO_ACCOUNT_SID` from Twilio Console (do not commit) |
| Brand Registration | `BN0a864697b432e6be3551efe69b9bb064` |
| Campaign | `CMdde30606a066ea5d5c2a4abe6dbd4339` |
| Messaging Service | `MG01ab31b68291d60514f7cb6af98f5a57` |

Campaign created: `2026-05-12T02:15:19.650Z`

## Railway / env vars

```
TWILIO_ACCOUNT_SID=<Twilio Console — never commit>
TWILIO_AUTH_TOKEN=<Twilio Console — never commit>
TWILIO_FROM_NUMBER=+19045067476
TWILIO_MESSAGING_SERVICE_SID=MG01ab31b68291d60514f7cb6af98f5a57
TWILIO_CAMPAIGN_SID=CMdde30606a066ea5d5c2a4abe6dbd4339
TWILIO_BRAND_SID=BN0a864697b432e6be3551efe69b9bb064
```

Local agent copy of non-secret + account SID (gitignored path): `~/.localintel-twilio.env`

## Ops checklist after approval

1. Confirm `(904) 506-7476` is attached to Messaging Service `MG01ab31b68291d60514f7cb6af98f5a57`
2. Confirm SMS webhook: `https://gsb-swarm-production.up.railway.app/api/rfq/sms-inbound`
3. Test SMS to a real handset (carrier number registration can lag after campaign approval)
4. Keep SMS opt-in optional on signup (forced consent caused prior rejects)

## Related

- Consent: `https://www.thelocalintel.com/sms-signup.html`
- Privacy / Terms: `https://www.thelocalintel.com/privacy` · `https://www.thelocalintel.com/terms`
