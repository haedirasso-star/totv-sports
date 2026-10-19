// ════════════════════════════════════════════════════════════════════
//  TOTV+ Sports Feed — خلاصة المباريات المشتركة لكل المستخدمين
//
//  يعمل على GitHub Actions كل 5 دقائق (مجاناً للمستودع العام):
//    1) يجلب جدول اليوم والغد من API-Football بطلب واحد لكل يوم
//    2) أثناء المباريات فقط: طلب واحد يحدّث كل المباريات الجارية،
//       والفاصل بين الطلبات يُحسب تلقائياً من الرصيد المتبقي (100/يوم)
//    3) يحفظ شعارات الأندية مرة واحدة (روابط الشعارات لا تُحسب من الرصيد)
//    4) يترجم أسماء الفرق للعربية ويصوغ إشعار الانطلاق بالذكاء الاصطناعي
//       (Gemini — مجاني) ثم يرسله عبر Firebase Cloud Messaging (مجاني)
//    5) ينشر matches.json على GitHub Pages — التطبيق يقرأ هذا الملف فقط
//
//  المستخدمون لا يتصلون بـ API-Football أبداً: 50 ألف مستخدم = 0 طلب إضافي.
//  المفاتيح السرية في GitHub Secrets فقط — لا شيء منها في التطبيق.
// ════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const cfg   = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const DATA  = process.env.DATA_DIR || 'data';   // يُحفظ بين التشغيلات (actions/cache)
const OUT   = process.env.OUT_DIR  || 'out';    // يُنشر على GitHub Pages
const MOCK  = process.env.MOCK_DIR || '';       // للاختبار المحلي فقط
const KEY   = process.env.API_FOOTBALL_KEY || '';
const GKEY  = process.env.GEMINI_API_KEY || '';
const SA    = process.env.FCM_SERVICE_ACCOUNT || '';
const FEED  = (process.env.FEED_URL || '').replace(/\/+$/, '');
const TEST  = String(process.env.TEST_NOTIFY || '') === 'true';

const NOW   = Number(process.env.NOW_MS || Date.now());
const nowS  = Math.floor(NOW / 1000);
const log   = (...a) => console.log('[feed]', ...a);

const LEAGUES = new Map(cfg.leagues.map(l => [l.id, l]));
const TZ      = cfg.timezone || 'Asia/Baghdad';
const LIVE    = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);
const DONE    = new Set(['FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD', 'AWD', 'WO']);
const BIG     = new Set((cfg.bigTeams || []).map(s => s.toLowerCase()));

const dayOf = ms => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const TODAY = dayOf(NOW), TOMORROW = dayOf(NOW + 864e5), YESTERDAY = dayOf(NOW - 864e5);
const UTC_DAY  = new Date(NOW).toISOString().slice(0, 10);
const RESET_S  = Math.floor(Date.UTC(...UTC_DAY.split('-').map((v, i) => i === 1 ? v - 1 : +v)) / 1000) + 86400;

const readJson  = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
const sleep     = ms => new Promise(r => setTimeout(r, ms));

// ── الحالة المحفوظة ──────────────────────────────────────────────
let state = readJson(`${DATA}/state.json`, null);
let store = readJson(`${DATA}/matches.json`, null);
if ((!state || !store) && FEED && !MOCK) {          // استعادة من الموقع المنشور إن ضاع الكاش
  try { state ??= await (await fetch(`${FEED}/state.json?r=${nowS}`)).json(); } catch {}
  try { store ??= await (await fetch(`${FEED}/matches.json?r=${nowS}`)).json(); } catch {}
}
state ??= {};
state.sched    ??= {};
state.notified ??= {};
state.teamsAr  ??= {};
state.used     ??= 0;
state.lastLive ??= 0;
if (state.quotaDay !== UTC_DAY) { state.quotaDay = UTC_DAY; state.used = 0; state.remaining = null; state.ai = 0; }
if (state.notifyDay?.day !== TODAY) state.notifyDay = { day: TODAY, count: 0 };

const byId = new Map((store?.matches || []).map(m => [m.id, m]));
const left = () => (state.remaining ?? (cfg.dailyBudget - state.used)) - cfg.safetyReserve;

// ── API-Football (كل طلب يُحسب من الـ 100) ──────────────────────
async function api(q) {
  if (left() < 1) { log('⛔ الرصيد اليومي محجوز — لا طلبات'); return null; }
  let j;
  if (MOCK) {
    const f = path.join(MOCK, q.replace(/[^a-z0-9]+/gi, '_') + '.json');
    j = readJson(f, { response: [] });
    state.used++;
  } else {
    if (!KEY) { log('⚠️ API_FOOTBALL_KEY غير موجود'); return null; }
    try {
      const r = await fetch(`https://v3.football.api-sports.io/${q}`, {
        headers: { 'x-apisports-key': KEY } });
      state.used++;
      const rem = r.headers.get('x-ratelimit-requests-remaining');
      if (rem !== null && rem !== '') state.remaining = Number(rem);
      j = await r.json();
    } catch (e) { state.lastError = String(e); log('شبكة:', e); return null; }
  }
  const errs = j?.errors && (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors).length);
  if (errs) { state.lastError = JSON.stringify(j.errors); log('❌ API:', state.lastError); return null; }
  state.lastError = '';
  log(`✓ ${q}  (مستخدم اليوم ${state.used}${state.remaining != null ? `، المتبقي ${state.remaining}` : ''})`);
  return j.response || [];
}

function conv(f) {
  const lg = f?.league?.id;
  if (!LEAGUES.has(lg)) return null;
  const side = s => ({ id: f.teams[s].id, n: f.teams[s].name, src: f.teams[s].logo });
  return {
    id: f.fixture.id, lg, rd: f.league.round || '', ts: f.fixture.timestamp,
    st: f.fixture.status?.short || 'NS', el: f.fixture.status?.elapsed ?? null,
    h: side('home'), a: side('away'), gh: f.goals?.home ?? null, ga: f.goals?.away ?? null,
    venue: f.fixture.venue?.name || '', lgSrc: f.league.logo || '',
  };
}

function mergeLive(m) {
  const old = byId.get(m.id);
  byId.set(m.id, old ? { ...old, st: m.st, el: m.el, gh: m.gh, ga: m.ga, ts: m.ts } : m);
}

// ── 1) الجدول: طلب واحد يغطي كل الدوريات ليوم كامل ──────────────
async function fetchDay(day) {
  const res = await api(`fixtures?date=${day}&timezone=${encodeURIComponent(TZ)}`);
  if (!res) return false;
  const fresh = res.map(conv).filter(Boolean);
  for (const [id, m] of byId) if (dayOf(m.ts * 1000) === day) byId.delete(id); // مباريات تأجلت/نُقلت
  for (const m of fresh) byId.set(m.id, m);
  state.sched[day] = NOW;
  log(`📅 ${day}: ${fresh.length} مباراة من الدوريات المختارة`);
  return true;
}

const stale = d => !state.sched[d] || NOW - state.sched[d] > cfg.scheduleRefreshHours * 3600e3;
if (stale(TODAY))       await fetchDay(TODAY);
if (!state.sched[TOMORROW]) await fetchDay(TOMORROW);

// تنظيف: نبقي أمس واليوم والغد فقط
for (const [id, m] of byId) {
  const d = dayOf(m.ts * 1000);
  if (d !== YESTERDAY && d !== TODAY && d !== TOMORROW) byId.delete(id);
}
for (const d of Object.keys(state.sched)) if (d < YESTERDAY) delete state.sched[d];

// ── 2) التحديث المباشر — فقط أثناء المباريات وبفاصل محسوب ───────
const isActive = m => !DONE.has(m.st) && (LIVE.has(m.st) || (nowS >= m.ts - 120 && nowS <= m.ts + 130 * 60));

function windowMinutes() {          // دقائق المباريات المتبقية حتى تجديد الرصيد (منتصف الليل UTC)
  const iv = [];
  for (const m of byId.values()) {
    if (DONE.has(m.st)) continue;
    let s = Math.max(nowS, m.ts - 120), e = Math.min(RESET_S, m.ts + 130 * 60);
    if (LIVE.has(m.st) && e <= nowS) e = Math.min(RESET_S, nowS + 20 * 60); // وقت إضافي
    if (e > s) iv.push([s, e]);
  }
  iv.sort((a, b) => a[0] - b[0]);
  let total = 0, cs = -1, ce = -1;
  for (const [s, e] of iv) {
    if (s > ce) { if (ce > cs) total += ce - cs; cs = s; ce = e; } else ce = Math.max(ce, e);
  }
  if (ce > cs) total += ce - cs;
  return total / 60;
}

const active   = [...byId.values()].filter(isActive);
const mins     = windowMinutes();
const interval = Math.min(30, Math.max(5, Math.ceil(mins / Math.max(1, left()))));
const sinceMin = (NOW - state.lastLive) / 60000;
log(`⏱ مباريات جارية: ${active.length} — دقائق متبقية ${Math.round(mins)} — الفاصل ${interval}د — منذ آخر تحديث ${sinceMin.toFixed(1)}د`);

if (active.length && left() >= 1 && sinceMin >= interval - 0.5) {
  let res;
  if (active.length <= 20) {
    res = await api(`fixtures?ids=${active.map(m => m.id).join('-')}&timezone=${encodeURIComponent(TZ)}`);
  } else {
    res = await api(`fixtures?live=${[...LEAGUES.keys()].join('-')}&timezone=${encodeURIComponent(TZ)}`);
    if (res) {                      // مباراة اختفت من «المباشر» بعد وقتها = انتهت (يصحّحه تحديث الجدول)
      const seen = new Set(res.map(f => f.fixture.id));
      for (const m of active) if (LIVE.has(m.st) && !seen.has(m.id) && nowS > m.ts + 105 * 60) m.st = 'FT';
    }
  }
  if (res) { for (const f of res) { const m = conv(f); if (m) mergeLive(m); } state.lastLive = NOW; }
}

// ── 3) أهمية المباريات (للإشعار وللبانر) ─────────────────────────
const score = m => (LEAGUES.get(m.lg)?.weight || 0)
  + 5 * ((BIG.has(m.h.n.toLowerCase()) ? 1 : 0) + (BIG.has(m.a.n.toLowerCase()) ? 1 : 0));
for (const d of [YESTERDAY, TODAY, TOMORROW]) {
  const list = [...byId.values()].filter(m => dayOf(m.ts * 1000) === d);
  list.forEach(m => { m.score = score(m); m.imp = false; });
  list.filter(m => m.score >= cfg.importanceThreshold)
      .sort((a, b) => b.score - a.score || a.ts - b.ts)
      .slice(0, cfg.maxNotificationsPerDay)
      .forEach(m => { m.imp = true; });
}

// ── 4) شعارات الأندية والدوريات — تُحفظ مرة واحدة (مجانية) ──────
let newLogos = 0;
async function saveLogo(file, src) {
  const p = `${DATA}/logos/${file}`;
  if (!src || fs.existsSync(p) || MOCK || newLogos >= 60) return;
  try {
    const r = await fetch(src);
    if (!r.ok) return;
    fs.mkdirSync(`${DATA}/logos`, { recursive: true });
    fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
    newLogos++; await sleep(120);
  } catch {}
}
for (const m of byId.values()) {
  await saveLogo(`t${m.h.id}.png`, m.h.src);
  await saveLogo(`t${m.a.id}.png`, m.a.src);
  await saveLogo(`l${m.lg}.png`, m.lgSrc);
}

// ── 5) الذكاء الاصطناعي (Gemini — مجاني) ─────────────────────────
const AR_SEED = {
  'Real Madrid': 'ريال مدريد', 'Barcelona': 'برشلونة', 'Atletico Madrid': 'أتلتيكو مدريد',
  'Manchester City': 'مانشستر سيتي', 'Manchester United': 'مانشستر يونايتد', 'Liverpool': 'ليفربول',
  'Arsenal': 'آرسنال', 'Chelsea': 'تشيلسي', 'Tottenham': 'توتنهام', 'Bayern München': 'بايرن ميونخ',
  'Bayern Munich': 'بايرن ميونخ', 'Borussia Dortmund': 'بوروسيا دورتموند', 'Juventus': 'يوفنتوس',
  'Inter': 'إنتر ميلان', 'AC Milan': 'ميلان', 'Napoli': 'نابولي', 'Paris Saint Germain': 'باريس سان جيرمان',
  'Iraq': 'العراق', 'Saudi Arabia': 'السعودية',
};
const arName = n => state.teamsAr[n] || AR_SEED[n] || '';

async function gemini(prompt) {
  if (!GKEY || MOCK || (state.ai || 0) >= 40) return null;
  state.ai = (state.ai || 0) + 1;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GKEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.8 },
      }),
    });
    const j = await r.json();
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) { log('AI: رد فارغ', JSON.stringify(j).slice(0, 300)); return null; }
    return JSON.parse(txt);
  } catch (e) { log('AI:', e.message); return null; }
}

// ترجمة أسماء الفرق الجديدة — طلب واحد لكل الأسماء، وتُحفظ للأبد
const missing = [...new Set([...byId.values()]
  .filter(m => dayOf(m.ts * 1000) !== YESTERDAY)
  .flatMap(m => [m.h.n, m.a.n]).filter(n => !arName(n)))].slice(0, 80);
if (missing.length) {
  const tr = await gemini(
    'ترجم أسماء أندية ومنتخبات كرة القدم التالية إلى الاسم العربي الشائع في الإعلام الرياضي العربي. ' +
    'أعد كائن JSON فقط: المفتاح هو الاسم الأصلي حرفياً والقيمة هي الاسم العربي.\n' + JSON.stringify(missing));
  if (tr && typeof tr === 'object') for (const n of missing) if (typeof tr[n] === 'string' && tr[n].trim()) state.teamsAr[n] = tr[n].trim();
}

// ── 6) إشعار انطلاق المباريات المهمة (FCM — مجاني) ───────────────
async function fcmToken(sa) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('FCM auth: ' + JSON.stringify(j));
  return j.access_token;
}

let _tok = null;
async function push(topic, title, body, data = {}) {
  if (MOCK) { log(`🔔 [تجريبي] ${topic}: ${title} — ${body}`); return true; }
  if (!SA) { log('⚠️ FCM_SERVICE_ACCOUNT غير موجود — لن يُرسل إشعار'); return false; }
  try {
    const sa = JSON.parse(SA);
    _tok ??= await fcmToken(sa);
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${_tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        topic, notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        android: { priority: 'HIGH', notification: { channel_id: 'totv_main', sound: 'default' } },
        apns: { payload: { aps: { sound: 'default' } } },
      } }),
    });
    if (!r.ok) { log('FCM ❌', r.status, await r.text()); return false; }
    log(`🔔 أُرسل: ${title}`);
    return true;
  } catch (e) { log('FCM ❌', e.message); return false; }
}

async function composeKickoff(m) {
  const H = arName(m.h.n) || m.h.n, A = arName(m.a.n) || m.a.n;
  const L = LEAGUES.get(m.lg)?.ar || '';
  const fallback = { title: `⚽ انطلقت الآن: ${H} × ${A}`, body: `${L} — تابعها مباشرة الآن على TOTV+` };
  const ai = await gemini(
    'أنت محرر إشعارات لتطبيق بث رياضي عربي اسمه TOTV+. اكتب إشعار انطلاق مباراة جذاباً وقصيراً.\n' +
    `المباراة: ${H} ضد ${A}\nالبطولة: ${L}\nالجولة: ${m.rd}\nالملعب: ${m.venue}\n` +
    'الشروط: عنوان لا يتجاوز 45 حرفاً يبدأ برمز تعبيري واحد مناسب ويذكر الفريقين، ونص لا يتجاوز 110 أحرف ' +
    'يدعو للمشاهدة الآن على TOTV+. لا تخترع نتائج أو ترتيباً أو أخباراً غير مذكورة. ' +
    'أعد JSON فقط بالشكل {"title":"...","body":"..."}');
  const ok = ai && typeof ai.title === 'string' && typeof ai.body === 'string'
    && ai.title.length >= 8 && ai.title.length <= 70 && ai.body.length >= 8 && ai.body.length <= 160;
  return ok ? { title: ai.title.trim(), body: ai.body.trim() } : fallback;
}

if (TEST) {
  await push('admins', '✅ تجربة إشعارات TOTV+', 'نظام إشعارات المباريات يعمل بنجاح', { type: 'match' });
}
for (const m of [...byId.values()].sort((a, b) => b.score - a.score)) {
  if (!m.imp || state.notified[m.id] || dayOf(m.ts * 1000) !== TODAY) continue;
  if (state.notifyDay.count >= cfg.maxNotificationsPerDay) break;
  if (['PST', 'CANC', 'ABD', 'SUSP', 'FT', 'AET', 'PEN'].includes(m.st)) continue;
  if (nowS < m.ts - 60 || nowS > m.ts + 25 * 60) continue;
  const msg = await composeKickoff(m);
  if (await push(cfg.notifyTopic || 'matches', msg.title, msg.body, { type: 'match', fixture: m.id })) {
    state.notified[m.id] = NOW; state.notifyDay.count++;
  }
}
for (const [id, t] of Object.entries(state.notified)) if (NOW - t > 3 * 864e5) delete state.notified[id];

// ── 7) الكتابة والنشر ─────────────────────────────────────────────
const logo = f => fs.existsSync(`${DATA}/logos/${f}`) ? `logos/${f}` : '';
const matches = [...byId.values()].sort((a, b) => a.ts - b.ts);
const leaguesOut = Object.fromEntries(cfg.leagues.map(l => [l.id, { ar: l.ar, order: l.order, logo: logo(`l${l.id}.png`) }]));
const feed = {
  v: 1, updated: nowS, tz: TZ, today: TODAY,
  leagues: leaguesOut,
  channels: cfg.channels || {},
  matches: matches.map(m => ({
    id: m.id, lg: m.lg, rd: m.rd, ts: m.ts, st: m.st, el: m.el, gh: m.gh, ga: m.ga,
    imp: !!m.imp, venue: m.venue,
    h: { id: m.h.id, n: m.h.n, ar: arName(m.h.n), logo: logo(`t${m.h.id}.png`) },
    a: { id: m.a.id, n: m.a.n, ar: arName(m.a.n), logo: logo(`t${m.a.id}.png`) },
    ch: cfg.overrides?.[m.id] ? [cfg.overrides[m.id]] : [],
  })),
};

// نحتفظ بالحقول الداخلية (src, score) في نسخة الكاش فقط
writeJson(`${DATA}/matches.json`, { ...feed, matches });

const hash = crypto.createHash('sha1').update(JSON.stringify({ ...feed, updated: 0 })).digest('hex');
const heartbeat = NOW - (state.lastDeploy || 0) > 60 * 60e3;
const changed = hash !== state.lastHash || newLogos > 0 || heartbeat || TEST;
const keepalive = NOW - (state.lastKeepalive || 0) > 25 * 864e5;
if (changed) { state.lastHash = hash; state.lastDeploy = NOW; }
if (keepalive) state.lastKeepalive = NOW;

const status = {
  updated: nowS, quotaDay: state.quotaDay, used: state.used, remaining: state.remaining,
  liveNow: active.length, intervalMin: interval, today: matches.filter(m => dayOf(m.ts * 1000) === TODAY).length,
  notifiedToday: state.notifyDay.count, lastError: state.lastError || '', ai: state.ai || 0,
};
state.status = status;
writeJson(`${DATA}/state.json`, state);

if (changed) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(`${OUT}/logos`, { recursive: true });
  writeJson(`${OUT}/matches.json`, feed);
  writeJson(`${OUT}/state.json`, state);
  writeJson(`${OUT}/status.json`, status);
  if (fs.existsSync(`${DATA}/logos`)) fs.cpSync(`${DATA}/logos`, `${OUT}/logos`, { recursive: true });
  fs.copyFileSync('scripts/status.html', `${OUT}/index.html`);
  fs.writeFileSync(`${OUT}/.nojekyll`, '');
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nkeepalive=${keepalive}\n`);
}
log(`انتهى — نشر: ${changed ? 'نعم' : 'لا تغيير'} | طلبات اليوم ${state.used} | شعارات جديدة ${newLogos}`);
