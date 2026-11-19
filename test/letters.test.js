import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { makeDB } from './d1shim.js';
import worker, { deliverDue } from '../src/index.js';
import { validateLetter, computeDeliverAt, encryptText, decryptText, sha256Hex } from '../src/lib.js';

const KEY = randomBytes(32).toString('base64');
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0); // 20 Nov 2026
const good = (o = {}) => ({ email: 'Sam@Example.com', subject: 'Hello', message: 'Dear me, I hope you are well and happy.', date: '2027-01-15', tzOffset: -330, consent: true, website: '', ...o });

function makeEnv() {
  return { DB: makeDB(), ENCRYPTION_KEY: KEY, RESEND_API_KEY: 'x', FROM_EMAIL: 'L <l@example.com>', SITE_URL: 'https://x.test', ASSETS: { fetch: async () => new Response('asset') } };
}
function capture() {
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); };
  return sent;
}
const post = (env, body) => worker.fetch(new Request('https://x.test/api/letters', { method: 'POST', body: JSON.stringify(body) }), env);
const form = (path, t) => new Request('https://x.test' + path, { method: 'POST', body: new URLSearchParams({ t }) });
const tokenFrom = (mail) => new URL(mail.html.match(/href="([^"]+)"/)[1].replace(/&amp;/g, '&')).searchParams.get('t');

test('delivery time is 9:00 in the writer\'s own time zone', () => {
  assert.equal(new Date(computeDeliverAt('2027-01-15', -330)).toISOString(), '2027-01-15T03:30:00.000Z'); // India
  assert.equal(new Date(computeDeliverAt('2027-01-15', 300)).toISOString(), '2027-01-15T14:00:00.000Z'); // New York
});

test('validation accepts a good letter and rejects bad ones', () => {
  assert.equal(validateLetter(good(), {}, NOW).ok, true);
  assert.equal(validateLetter(good({ email: 'nope' }), {}, NOW).ok, false);
  assert.equal(validateLetter(good({ message: 'too short' }), {}, NOW).ok, false);
  assert.equal(validateLetter(good({ date: '2027-02-31' }), {}, NOW).ok, false);
  assert.equal(validateLetter(good({ date: '2026-11-20' }), {}, NOW).ok, false, 'today is not allowed');
  assert.equal(validateLetter(good({ date: '2026-11-21' }), {}, NOW).ok, true, 'tomorrow is allowed');
  assert.equal(validateLetter(good({ date: '2033-01-01' }), {}, NOW).ok, false, 'beyond 5 years');
  assert.equal(validateLetter(good({ consent: false }), {}, NOW).ok, false);
  assert.equal(validateLetter(good({ website: 'spam.com' }), {}, NOW).bot, true);
});

test('encryption round-trips, handles Indian scripts, and a wrong key fails', async () => {
  const text = 'ନମସ୍କାର, भविष्य के नाम — hello 🙂';
  const enc = await encryptText(text, KEY);
  assert.ok(!enc.includes('hello'));
  assert.equal(await decryptText(enc, KEY), text);
  await assert.rejects(decryptText(enc, randomBytes(32).toString('base64')));
});

test('full journey: write, confirm, wait, deliver, erase', async () => {
  const env = makeEnv();
  const sent = capture();
  const secret = 'Dear me, remember the mango tree. ଓଡ଼ିଆ';
  const res = await post(env, good({ message: secret, date: '2027-01-15' }));
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1, 'one confirmation email');
  assert.deepEqual(sent[0].to, ['sam@example.com']);
  assert.ok(!sent[0].html.includes('mango'), 'confirmation email never contains the letter');

  const row = env.DB.raw.prepare('SELECT * FROM letters').get();
  assert.equal(row.status, 'pending');
  assert.ok(!JSON.stringify(row).includes('mango'), 'letter text is not stored in plain form');

  const token = tokenFrom(sent[0]);
  const manage = await worker.fetch(new Request('https://x.test/api/manage?t=' + token), env);
  assert.equal(manage.status, 200);
  assert.match(await manage.text(), /Confirm your letter/);
  assert.equal(env.DB.raw.prepare('SELECT status FROM letters').get().status, 'pending', 'opening the link alone does not confirm');

  assert.equal((await worker.fetch(form('/api/confirm', token), env)).status, 200);
  assert.equal(env.DB.raw.prepare('SELECT status FROM letters').get().status, 'scheduled');

  assert.deepEqual(await deliverDue(env, NOW), { sent: 0, failed: 0 }, 'nothing is due yet');
  const due = row.deliver_at + 1000;
  assert.deepEqual(await deliverDue(env, due), { sent: 1, failed: 0 });
  assert.equal(sent.length, 2);
  assert.ok(sent[1].html.includes('mango') && sent[1].text.includes('ଓଡ଼ିଆ'));
  assert.equal(sent[1].subject, 'Hello');

  const after = env.DB.raw.prepare('SELECT * FROM letters').get();
  assert.equal(after.status, 'sent');
  assert.equal(after.email, null);
  assert.equal(after.body_enc, null);
  assert.deepEqual(await deliverDue(env, due + 1000), { sent: 0, failed: 0 }, 'never sent twice');
  assert.match(await (await worker.fetch(new Request('https://x.test/api/manage?t=' + token), env)).text(), /delivered/);
});

test('a failed send is retried, then marked failed after five tries', async () => {
  const env = makeEnv();
  const sent = capture();
  await post(env, good());
  const token = tokenFrom(sent[0]);
  await worker.fetch(form('/api/confirm', token), env);
  const at = env.DB.raw.prepare('SELECT deliver_at FROM letters').get().deliver_at + 1000;
  globalThis.fetch = async () => new Response('no', { status: 500 });
  for (let i = 1; i <= 5; i++) {
    assert.deepEqual(await deliverDue(env, at + i * 1000), { sent: 0, failed: 1 });
  }
  const row = env.DB.raw.prepare('SELECT status, attempts FROM letters').get();
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 5);
});

test('delete erases everything and the link stops working', async () => {
  const env = makeEnv();
  const sent = capture();
  await post(env, good());
  const token = tokenFrom(sent[0]);
  assert.equal((await worker.fetch(form('/api/delete', token), env)).status, 200);
  const row = env.DB.raw.prepare('SELECT * FROM letters').get();
  assert.equal(row.status, 'deleted');
  assert.equal(row.email, null);
  assert.equal(row.body_enc, null);
  assert.equal((await worker.fetch(form('/api/confirm', token), env)).status, 404);
});

test('unconfirmed letters are erased after 48 hours', async () => {
  const env = makeEnv();
  capture();
  await post(env, good());
  await deliverDue(env, Date.now() + 49 * 3600 * 1000);
  const row = env.DB.raw.prepare('SELECT status, body_enc FROM letters').get();
  assert.equal(row.status, 'deleted');
  assert.equal(row.body_enc, null);
});

test('limits: pending per address, daily cap, bots, size, failed email', async () => {
  const env = makeEnv();
  capture();
  for (let i = 0; i < 3; i++) assert.equal((await post(env, good())).status, 200);
  assert.equal((await post(env, good())).status, 429, 'fourth unconfirmed letter is refused');
  assert.equal((await post(env, good({ email: 'other@example.com', website: 'x' }))).status, 200, 'bot looks successful');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) c FROM letters WHERE email='other@example.com'").get().c, 0, 'bot stored nothing');

  const env2 = makeEnv();
  env2.MAX_NEW_PER_DAY = '1';
  capture();
  assert.equal((await post(env2, good())).status, 200);
  assert.equal((await post(env2, good({ email: 'b@example.com' }))).status, 429);

  const big = await worker.fetch(new Request('https://x.test/api/letters', { method: 'POST', body: 'x'.repeat(70000) }), makeEnv());
  assert.equal(big.status, 413);

  const env3 = makeEnv();
  globalThis.fetch = async () => new Response('bad', { status: 422 });
  assert.equal((await post(env3, good())).status, 502);
  assert.equal(env3.DB.raw.prepare('SELECT body_enc FROM letters').get().body_enc, null, 'nothing kept when the email fails');
});

test('other paths go to the static site, unknown API paths are 404', async () => {
  const env = makeEnv();
  assert.equal(await (await worker.fetch(new Request('https://x.test/'), env)).text(), 'asset');
  assert.equal((await worker.fetch(new Request('https://x.test/api/nope'), env)).status, 404);
  assert.equal(await sha256Hex('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
});
