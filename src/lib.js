import { PLANS, SETTINGS, planFor } from './config.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DAY = 24 * 60 * 60 * 1000;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- dates ---------- */
// tzOffset is what the browser reports: minutes UTC is ahead of local time (India: -330).
export function computeDeliverAt(dateStr, tzOffset) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, SETTINGS.deliveryHourLocal, 0, 0) + tzOffset * 60000;
}
function isRealDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export function localDateString(ms, tzOffset) {
  return new Date(ms - tzOffset * 60000).toISOString().slice(0, 10);
}
export function prettyDate(ms, tzOffset) {
  return new Date(ms - tzOffset * 60000).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
}

/* ---------- validation ---------- */
export function validateLetter(input, env = {}, now = Date.now()) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Please fill in the form.' };
  if (input.website) return { ok: false, bot: true, error: 'Something went wrong. Please try again.' };

  const email = String(input.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
  const plan = PLANS[planFor(env, email)];

  const message = String(input.message || '').trim();
  if (message.length < plan.minMessageChars) return { ok: false, error: `Your letter needs at least ${plan.minMessageChars} characters.` };
  if (message.length > plan.maxMessageChars) return { ok: false, error: `Your letter can be up to ${plan.maxMessageChars} characters.` };

  let subject = String(input.subject || '').trim();
  if (subject.length > plan.maxSubjectChars) return { ok: false, error: `Please keep the subject under ${plan.maxSubjectChars} characters.` };
  if (!subject) subject = 'A letter from your past self';

  const date = String(input.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) return { ok: false, error: 'Please choose a delivery date.' };

  const tzOffset = Number(input.tzOffset);
  if (!Number.isInteger(tzOffset) || Math.abs(tzOffset) > 840) return { ok: false, error: 'We could not read your time zone. Please reload the page.' };

  if (input.consent !== true) return { ok: false, error: 'Please tick the box to continue.' };

  if (date <= localDateString(now, tzOffset)) return { ok: false, error: 'Please choose a date from tomorrow onwards.' };
  const deliverAt = computeDeliverAt(date, tzOffset);
  if (deliverAt > now + plan.maxYearsAhead * 366 * DAY) return { ok: false, error: `Letters can be scheduled up to ${plan.maxYearsAhead} years ahead.` };

  return { ok: true, value: { email, subject, message, deliverAt, tzOffset, plan: plan } };
}

/* ---------- crypto ---------- */
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function aesKey(keyB64) {
  const raw = fromB64(String(keyB64 || ''));
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptText(text, keyB64) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), new TextEncoder().encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64(out);
}
export async function decryptText(b64, keyB64) {
  const raw = fromB64(b64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(keyB64), raw.slice(12));
  return new TextDecoder().decode(pt);
}
export function newToken() {
  return toB64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function sha256Hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- email ---------- */
const shell = (inner) => `<!doctype html><html><body style="margin:0;padding:24px;background:#EEF3F8;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#14233A">
<div style="max-width:560px;margin:0 auto;border-radius:6px;padding:6px;background:repeating-linear-gradient(135deg,#D9442F 0 14px,#fff 14px 28px,#2F5DA8 28px 42px,#fff 42px 56px)">
<div style="background:#FBFCFE;border-radius:3px;padding:28px 26px;line-height:1.6;font-size:16px">${inner}
<p style="margin:28px 0 0;font-size:13px;color:#4B5B73">${escapeHtml(SETTINGS.brand)} &middot; ${escapeHtml(SETTINGS.family)}</p>
</div></div></body></html>`;

export function confirmEmail({ manageUrl, deliverAt, tzOffset }) {
  const when = prettyDate(deliverAt, tzOffset);
  return {
    subject: 'Please confirm your letter',
    html: shell(`<h1 style="font-size:22px;margin:0 0 12px">One last step</h1>
<p>Your letter is ready to be sealed for <strong>${escapeHtml(when)}</strong>. It is not scheduled until you confirm.</p>
<p><a href="${escapeHtml(manageUrl)}" style="display:inline-block;background:#C73A26;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700">Confirm my letter</a></p>
<p style="font-size:14px;color:#4B5B73">If you did not write a letter, ignore this email and it will be erased within ${SETTINGS.pendingExpiryHours} hours. You can also delete it from the same link.</p>`),
    text: `Your letter is ready to be sealed for ${when}. Confirm it here: ${manageUrl}\n\nIf you did not write a letter, ignore this email and it will be erased within ${SETTINGS.pendingExpiryHours} hours.`,
  };
}

export function deliveryEmail({ subject, message, writtenAt, tzOffset }) {
  const written = prettyDate(writtenAt, tzOffset);
  return {
    subject,
    html: shell(`<p style="margin:0 0 18px;font-size:14px;color:#4B5B73">You wrote this on ${escapeHtml(written)}.</p>
<div style="white-space:pre-wrap;word-wrap:break-word">${escapeHtml(message)}</div>
<p style="margin:28px 0 0;font-size:14px;color:#4B5B73">This letter has now been erased from our system, so keep this email if you want to read it again.</p>`),
    text: `You wrote this on ${written}.\n\n${message}\n\nThis letter has now been erased from our system, so keep this email if you want to read it again.`,
  };
}

export async function sendEmail(env, { to, subject, html, text }) {
  if (env.DRY_RUN === 'true') {
    console.log('DRY_RUN: would send an email'); // never log addresses or letter text
    return true;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html, text }),
  });
  return r.ok;
}
