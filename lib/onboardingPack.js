'use strict';
/**
 * lib/onboardingPack.js — One-pager / email pack for businesses.
 * Everything important in one place so they are not scared into a long form.
 */

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPackJson(biz, { token = null, home = null } = {}) {
  const inbox = token
    ? `https://www.thelocalintel.com/inbox.html?token=${token}`
    : (biz.dispatch_token
      ? `https://www.thelocalintel.com/inbox.html?token=${biz.dispatch_token}`
      : 'https://www.thelocalintel.com/claim');
  const presence = `https://gsb-swarm-production.up.railway.app/api/local-intel/presence/${biz.business_id}`;
  const listing = `https://www.thelocalintel.com/search.html?q=${encodeURIComponent(biz.name || '')}&zip=${encodeURIComponent(biz.zip || '')}`;

  return {
    title: `${biz.name} — LocalIntel business pack`,
    business: {
      id: biz.business_id,
      name: biz.name,
      category: biz.category,
      zip: biz.zip,
      address: biz.address,
      phone: biz.phone,
      specialty: biz.specialties_text || biz.tagline || biz.services_text || null,
    },
    links: {
      inbox,
      presence,
      listing,
      public_search: listing,
    },
    how_it_works: [
      'People and AI agents find what you do specially (not just a pin on a map).',
      'Jobs show up in your Business Home for one day — Accept, Quote, or Done.',
      'Get paid the way you already do: Surge catalog, invoice/cash, or wallet when you are ready.',
      'Agents may use prepaid cards or x402 — you just see Paid → confirm completion.',
    ],
    next_step: home?.next_action?.label
      || 'Add one specialty sentence in Broadcast, then share this pack.',
    fear_reducers: [
      'No bank login required to claim.',
      'No crypto wallet required to receive job alerts.',
      'You can stay invoice/cash forever.',
      'You control what is public in your presence profile.',
    ],
    generated_at: new Date().toISOString(),
  };
}

function buildPackHtml(biz, opts = {}) {
  const pack = buildPackJson(biz, opts);
  const qrTarget = encodeURIComponent(pack.links.listing);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(pack.title)}</title>
  <style>
    :root { --ink:#1a1a1a; --muted:#5c5c5c; --line:#e8e4dc; --bg:#faf8f4; --accent:#0f6b4c; }
    body { margin:0; font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
           background:var(--bg); color:var(--ink); line-height:1.45; }
    .sheet { max-width:640px; margin:32px auto; padding:40px 36px; background:#fff;
             border:1px solid var(--line); box-shadow:0 12px 40px rgba(26,26,26,.06); }
    h1 { font-size:1.75rem; margin:0 0 .25rem; letter-spacing:-.02em; }
    .sub { color:var(--muted); font-size:.95rem; margin:0 0 1.5rem; }
    h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.12em; color:var(--accent);
         margin:1.75rem 0 .6rem; font-family: system-ui, sans-serif; }
    ul { padding-left:1.1rem; margin:.4rem 0 0; }
    li { margin:.35rem 0; }
    a { color:var(--accent); }
    .btn { display:inline-block; margin-top:1rem; padding:.7rem 1.1rem; background:var(--accent);
           color:#fff !important; text-decoration:none; border-radius:4px; font-family:system-ui,sans-serif;
           font-size:.9rem; font-weight:600; }
    .qr { margin-top:1.25rem; }
    .qr img { width:140px; height:140px; border:1px solid var(--line); background:#fff; }
    .foot { margin-top:2rem; font-size:.8rem; color:var(--muted); font-family:system-ui,sans-serif; }
    @media print { body { background:#fff; } .sheet { box-shadow:none; border:none; margin:0; } }
  </style>
</head>
<body>
  <article class="sheet">
    <h1>${escapeHtml(pack.business.name || 'Your business')}</h1>
    <p class="sub">${escapeHtml([pack.business.category, pack.business.zip, pack.business.address].filter(Boolean).join(' · '))}</p>
    ${pack.business.specialty ? `<p><strong>Specialty:</strong> ${escapeHtml(pack.business.specialty)}</p>` : ''}

    <h2>Your private home</h2>
    <p>Bookmark this — jobs and messages land here:</p>
    <p><a class="btn" href="${escapeHtml(pack.links.inbox)}">Open Business Home</a></p>
    <p style="font-size:.85rem;word-break:break-all;"><a href="${escapeHtml(pack.links.inbox)}">${escapeHtml(pack.links.inbox)}</a></p>

    <h2>How LocalIntel works</h2>
    <ul>${pack.how_it_works.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>

    <h2>You do not need to fear this</h2>
    <ul>${pack.fear_reducers.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>

    <h2>Next step</h2>
    <p>${escapeHtml(pack.next_step)}</p>

    <h2>Share / QR</h2>
    <p>What people and agents see when they look you up:</p>
    <p style="font-size:.85rem;word-break:break-all;"><a href="${escapeHtml(pack.links.listing)}">${escapeHtml(pack.links.listing)}</a></p>
    <div class="qr">
      <img alt="QR code to listing" src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${qrTarget}"/>
    </div>

    <p class="foot">LocalIntel · thelocalintel.com · Generated ${escapeHtml(pack.generated_at)}</p>
  </article>
</body>
</html>`;
}

function buildPackEmailHtml(biz, opts = {}) {
  const pack = buildPackJson(biz, opts);
  return `
  <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:28px 20px;color:#1a1a1a;">
    <h1 style="font-size:22px;margin:0 0 6px;">${escapeHtml(pack.business.name)}</h1>
    <p style="color:#5c5c5c;margin:0 0 18px;">Your LocalIntel pack — everything important in one place.</p>
    <p style="margin:0 0 16px;"><a href="${escapeHtml(pack.links.inbox)}"
      style="background:#0f6b4c;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-family:system-ui,sans-serif;">
      Open Business Home →</a></p>
    <p style="font-size:14px;"><strong>Next step:</strong> ${escapeHtml(pack.next_step)}</p>
    <ul style="font-size:14px;line-height:1.5;">
      ${pack.fear_reducers.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}
    </ul>
    <p style="font-size:13px;color:#5c5c5c;">Full printable pack:<br>
      <a href="${escapeHtml(opts.packUrl || pack.links.listing)}">${escapeHtml(opts.packUrl || 'Download pack')}</a></p>
    <hr style="border:none;border-top:1px solid #e8e4dc;margin:24px 0;">
    <p style="font-size:12px;color:#9a9a9a;">LocalIntel · thelocalintel.com</p>
  </div>`;
}

module.exports = {
  buildPackJson,
  buildPackHtml,
  buildPackEmailHtml,
};
