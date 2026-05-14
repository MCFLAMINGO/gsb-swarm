# McFlamingo Reference

business_id, address, wallet, Surge catalog, wine items, one location only.

## McFlamingo Reference
- `business_id`: `232c34cb-ff82-4bf9-8a5c-d13306550709`
- ZIP: `32082`, phone: (904) 584-6665
- Address: 880 A1A N Suite 12, Ponte Vedra Beach FL 32082 (ONE LOCATION ONLY — second location closed)
- `pos_type`: `other` → routes to ucpAgent → surge.basalthq.com
- Surge price structure: `priceUsd: 0` on parent item, real price in `attributes.modifierGroups[].modifiers[].priceAdjustment`
- Wine items confirmed correct in Surge catalog (La Marca Prosecco 187ML $10, etc.)
- Hours: Mon-Sat 10:30-20:00, Wed 10:30-21:00, Sun 10:30-18:00
- Tags: healthy, organic, best_of_ponte_vedra, local_favorite, gluten_free, vegan_friendly, yelp_top_rated
- wallet: `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED`

---

---

## McFlamingo (Basalt / Surge Reference)

## McFlamingo Reference

| Field | Value |
|-------|-------|
| business_id | `232c34cb-ff82-4bf9-8a5c-d13306550709` |
| Basalt slug | `mcflamingo` |
| merchant wallet | `0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED` |
| jurisdictionCode | `US-FL` |
| Split configured | YES |
| Inventory SKUs | 92 (wine, food, beverages, dressings) |
| $0.00 items | Modifiers/add-ons — exclude from order UI |

---

## Three-Tier Architecture

```
Frontend (no key)
    ↓
gsb-swarm backend (holds BASALT_API_KEY)
    ↓
Basalt API (https://surge.basalthq.com)
```

Never expose `BASALT_API_KEY` to frontend. All Basalt calls must go through the gsb-swarm backend proxy.

---

