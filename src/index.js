import { PLANS, SETTINGS, planFor } from './config.js';
import {
  validateLetter, encryptText, decryptText, newToken, sha256Hex,
  confirmEmail, deliveryEmail, sendEmail, escapeHtml, prettyDate,
} from './lib.js';

const HOUR = 60 * 60 * 1000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const STYLE = `body{margin:0;padding:24px;background:#EEF3F8;color:#14233A;font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:520px;margin:8vh auto;background:#FBFCFE;border:1px solid #C9D6E6;border-radius:12px;padding:28px}
h1{font-size:22px;margin:0 0 10px}p{margin:0 0 14px}button{font:700 15px system-ui;border:0;border-radius:999px;padding:12px 22px;cursor:pointer;background:#C73A26;color:#fff}
button.quiet{background:transparent;color:#14233A;border:1.5px solid #C9D6E6;font-weight:500}form{display:inline-block;margin:0 8px 8px 0}`;

const page = (title, body, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" } },
  );

const ERASE = `status=?, email=NULL, subject_enc=NULL, body_enc=NULL`;

/* ---------- create a letter ---------- */
export async function createLetter(request, env, now = Date.now()) {
  const raw = await request.text();
  if (raw.length > SETTINGS.maxBodyBytes) return json({ ok: false, error: 'That letter is too long to send.' }, 413);
  let data;
  try { data = JSON.parse(raw); } catch { return json({ ok: false, error: 'Please fill in the form.' }, 400); }

  const v = validateLetter(data, env, now);
  if (v.bot) return json({ ok: true, message: 'Check your inbox to confirm your letter.' }); // say nothing to bots
  if (!v.ok) return json({ ok: false, error: v.error }, 400);
  const L = v.value;

  const cap = Number(env.MAX_NEW_PER_DAY || 200);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM letters WHERE created_at > ?').bind(now - 24 * HOUR).first();
  if (recent.c >= cap) return json({ ok: false, error: 'We are receiving a lot of letters right now. Please try again tomorrow.' }, 429);

  const active = await env.DB.prepare(`SELECT COUNT(*) AS c, SUM(status='pending') AS p FROM letters WHERE email = ? AND status IN ('pending','scheduled')`).bind(L.email).first();
  if ((active.p || 0) >= SETTINGS.maxPendingPerEmail) return json({ ok: false, error: 'Please confirm your earlier letters first. Check your inbox.' }, 429);
  if (active.c >= L.plan.maxActiveLetters) return json({ ok: false, error: `You already have ${L.plan.maxActiveLetters} letters waiting. You can write more after one is delivered.` }, 429);

  const id = crypto.randomUUID();
  const token = newToken();
  await env.DB.prepare(
    `INSERT INTO letters (id,email,subject_enc,body_enc,deliver_at,tz_offset,created_at,status,token_hash) VALUES (?,?,?,?,?,?,?,'pending',?)`,
  ).bind(id, L.email, await encryptText(L.subject, env.ENCRYPTION_KEY), await encryptText(L.message, env.ENCRYPTION_KEY), L.deliverAt, L.tzOffset, now, await sha256Hex(token)).run();

  const mail = confirmEmail({ manageUrl: `${env.SITE_URL}/api/manage?t=${token}`, deliverAt: L.deliverAt, tzOffset: L.tzOffset });
  const sent = await sendEmail(env, { to: L.email, ...mail });
  if (!sent) {
    await env.DB.prepare(`UPDATE letters SET ${ERASE} WHERE id=?`).bind('deleted', id).run();
    return json({ ok: false, error: 'We could not send the confirmation email. Please check the address and try again.' }, 502);
  }
  return json({ ok: true, message: 'Check your inbox to confirm your letter.' });
}

/* ---------- manage / confirm / delete ---------- */
async function findByToken(env, token) {
  if (!token || token.length < 20 || token.length > 100) return null;
  return env.DB.prepare('SELECT id,status,deliver_at,tz_offset,created_at FROM letters WHERE token_hash = ?').bind(await sha256Hex(token)).first();
}
const forms = (token, confirm) =>
  `${confirm ? `<form method="post" action="/api/confirm"><input type="hidden" name="t" value="${escapeHtml(token)}"><button>Yes, schedule my letter</button></form>` : ''}<form method="post" action="/api/delete"><input type="hidden" name="t" value="${escapeHtml(token)}"><button class="quiet">Delete this letter</button></form>`;
const GONE = () => page('Letter not found', '<h1>This link is no longer valid</h1><p>The letter may already have been delivered or deleted.</p>', 404);

export async function managePage(url, env, now = Date.now()) {
  const token = url.searchParams.get('t') || '';
  const row = await findByToken(env, token);
  if (!row) return GONE();
  const when = prettyDate(row.deliver_at, row.tz_offset);
  if (row.status === 'pending') {
    if (row.created_at < now - SETTINGS.pendingExpiryHours * HOUR) return GONE();
    return page('Confirm your letter', `<h1>Confirm your letter</h1><p>It will be delivered on <strong>${escapeHtml(when)}</strong>.</p>${forms(token, true)}`);
  }
  if (row.status === 'scheduled' || row.status === 'sending') return page('Your letter', `<h1>Your letter is sealed</h1><p>It will arrive on <strong>${escapeHtml(when)}</strong>. You can delete it any time before then.</p>${forms(token, false)}`);
  if (row.status === 'sent') return page('Delivered', '<h1>This letter was delivered</h1><p>It has been erased from our system. Check your inbox for the email.</p>');
  return GONE();
}

export async function confirmLetter(request, env, now = Date.now()) {
  const token = String((await request.formData()).get('t') || '');
  const row = await findByToken(env, token);
  if (!row || row.status !== 'pending' || row.created_at < now - SETTINGS.pendingExpiryHours * HOUR) return GONE();
  await env.DB.prepare(`UPDATE letters SET status='scheduled' WHERE id=? AND status='pending'`).bind(row.id).run();
  return page('Sealed', `<h1>Your letter is sealed</h1><p>It will arrive on <strong>${escapeHtml(prettyDate(row.deliver_at, row.tz_offset))}</strong>. Thank you for writing it.</p>`);
}

export async function deleteLetter(request, env) {
  const token = String((await request.formData()).get('t') || '');
  const row = await findByToken(env, token);
  if (!row || !['pending', 'scheduled'].includes(row.status)) return GONE();
  await env.DB.prepare(`UPDATE letters SET ${ERASE} WHERE id=?`).bind('deleted', row.id).run();
  return page('Deleted', '<h1>Your letter has been deleted</h1><p>It has been erased from our system.</p>');
}

/* ---------- scheduled delivery (runs every hour) ---------- */
export async function deliverDue(env, now = Date.now()) {
  await env.DB.prepare(`UPDATE letters SET ${ERASE} WHERE status='pending' AND created_at < ?`).bind('deleted', now - SETTINGS.pendingExpiryHours * HOUR).run();

  const due = await env.DB.prepare(
    `SELECT id,email,subject_enc,body_enc,tz_offset,created_at,attempts FROM letters
     WHERE (status='scheduled' OR (status='sending' AND claimed_at < ?)) AND deliver_at <= ?
     ORDER BY deliver_at LIMIT ?`,
  ).bind(now - SETTINGS.claimTimeoutMs, now, SETTINGS.batchSize).all();

  let sent = 0, failed = 0;
  for (const row of due.results) {
    const claim = await env.DB.prepare(`UPDATE letters SET status='sending', claimed_at=? WHERE id=? AND (status='scheduled' OR (status='sending' AND claimed_at < ?))`).bind(now, row.id, now - SETTINGS.claimTimeoutMs).run();
    if (!claim.meta.changes) continue; // another run took it
    let ok = false;
    try {
      const mail = deliveryEmail({
        subject: await decryptText(row.subject_enc, env.ENCRYPTION_KEY),
        message: await decryptText(row.body_enc, env.ENCRYPTION_KEY),
        writtenAt: row.created_at,
        tzOffset: row.tz_offset,
      });
      ok = await sendEmail(env, { to: row.email, ...mail });
    } catch (e) {
      console.error('delivery error', e.message);
    }
    if (ok) {
      await env.DB.prepare(`UPDATE letters SET ${ERASE}, sent_at=? WHERE id=?`).bind('sent', now, row.id).run();
      sent++;
    } else {
      const attempts = row.attempts + 1;
      await env.DB.prepare(`UPDATE letters SET status=?, attempts=? WHERE id=?`).bind(attempts >= SETTINGS.maxAttempts ? 'failed' : 'scheduled', attempts, row.id).run();
      failed++;
    }
  }
  return { sent, failed };
}

/* ---------- entry points ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/letters' && request.method === 'POST') return await createLetter(request, env);
      if (url.pathname === '/api/manage' && request.method === 'GET') return await managePage(url, env);
      if (url.pathname === '/api/confirm' && request.method === 'POST') return await confirmLetter(request, env);
      if (url.pathname === '/api/delete' && request.method === 'POST') return await deleteLetter(request, env);
      if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error('request error', e.message);
      return json({ ok: false, error: 'Something went wrong on our side. Please try again in a moment.' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(deliverDue(env));
  },
};
