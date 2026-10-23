// ════════════════════════════════════════════════════════════════════
//  TOTV+ Sports Feed v2 — مباريات الأسبوع لكل المستخدمين بملف واحد
//
//  يعمل على GitHub Actions كل 5 دقائق (مجاني للمستودع العام):
//    1) يجلب مباريات 7 أيام لكل الدوريات بطلب واحد (from/to)،
//       وإن رفضه الخادم يجلب يوماً بيوم (طلب لكل يوم يغطي كل الدوريات)
//    2) لا نتائج ولا تحديث مباشر ⇐ الاستهلاك نحو 4–13 طلباً يومياً من 100
//    3) شعارات الأندية مرة واحدة (لا تُحسب) + لون كل نادٍ من شعاره
//    4) صورة إشعار لكل مباراة: شعارا الفريقين على ألوانهما
//    5) «صافرة البداية»: إشعار عند انطلاق كل مباراة، يصوغه Gemini بحماس
//    6) إعلانات المباريات: صور مجلد promos تُربط بالمباراة وتُنشر
//    7) ينشر matches.json على GitHub Pages — التطبيق يقرأ هذا الملف فقط
// ════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* اختياري: بدونها لا ألوان ولا صور إشعار */ }

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
const OFF     = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP']);
const BIG     = new Set((cfg.bigTeams || []).map(s => s.toLowerCase()));
const R       = cfg.refresh || { weekHours: 6, todayHours: 4, tomorrowHours: 12, otherDaysHours: 24 };

const dayOf = ms => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const DAYS     = Array.from({ length: 7 }, (_, i) => dayOf(NOW + i * 864e5));
const TODAY    = DAYS[0], TOMORROW = DAYS[1], YESTERDAY = dayOf(NOW - 864e5);
const UTC_DAY  = new Date(NOW).toISOString().slice(0, 10);

function tzOffsetMin(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000);
}
const localToTs = (y, mo, d, h, mi) => {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return Math.floor((guess - tzOffsetMin(guess) * 60000) / 1000);
};

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
state.colors   ??= {};
state.used     ??= 0;
if (state.quotaDay !== UTC_DAY) { state.quotaDay = UTC_DAY; state.used = 0; state.remaining = null; state.ai = 0; }
if (state.notifyDay?.day !== TODAY) state.notifyDay = { day: TODAY, count: 0 };

const byId = new Map((store?.matches || []).map(m => [m.id, m]));
const left = () => (state.remaining ?? (cfg.dailyBudget - state.used)) - cfg.safetyReserve;

// ── API-Football (كل طلب يُحسب من الـ 100) ──────────────────────
async function api(q) {
  if (left() < 1) { log('⛔ الرصيد اليومي محجوز — لا طلبات'); return { res: null, errs: null }; }
  let j;
  if (MOCK) {
    const f = path.join(MOCK, q.replace(/[^a-z0-9]+/gi, '_') + '.json');
    j = readJson(f, { errors: { mock: 'missing ' + f }, response: [] });
    state.used++;
  } else {
    if (!KEY) { log('⚠️ API_FOOTBALL_KEY غير موجود'); return { res: null, errs: null }; }
    try {
      const r = await fetch(`https://v3.football.api-sports.io/${q}`, { headers: { 'x-apisports-key': KEY } });
      state.used++;
      const rem = r.headers.get('x-ratelimit-requests-remaining');
      if (rem !== null && rem !== '') state.remaining = Number(rem);
      j = await r.json();
    } catch (e) { state.lastError = String(e); log('شبكة:', e); return { res: null, errs: null }; }
  }
  const errs = j?.errors && (Array.isArray(j.errors) ? (j.errors.length ? j.errors : null)
                                                    : (Object.keys(j.errors).length ? j.errors : null));
  if (errs) { state.lastError = JSON.stringify(errs); log('❌ API:', state.lastError); return { res: null, errs }; }
  state.lastError = '';
  log(`✓ ${q}  (مستخدم اليوم ${state.used}${state.remaining != null ? `، المتبقي ${state.remaining}` : ''})`);
  return { res: j.response || [], errs: null };
}

function conv(f) {
  const lg = f?.league?.id;
  if (!LEAGUES.has(lg)) return null;
  const side = s => ({ id: f.teams[s].id, n: f.teams[s].name, src: f.teams[s].logo });
  return {
    id: f.fixture.id, lg, rd: f.league.round || '', ts: f.fixture.timestamp,
    st: f.fixture.status?.short || 'NS',
    h: side('home'), a: side('away'),
    venue: f.fixture.venue?.name || '', lgSrc: f.league.logo || '',
    // النتيجة النهائية (للتوقعات فقط — التطبيق لا يعرض النتائج)
    gh: f.goals?.home ?? null, ga: f.goals?.away ?? null,
  };
}

function absorb(list, days) {
  const fresh = list.map(conv).filter(Boolean);
  const set = new Set(days);
  for (const [id, m] of byId) if (set.has(dayOf(m.ts * 1000))) byId.delete(id);   // تأجيل/نقل
  for (const m of fresh) byId.set(m.id, m);
  for (const d of days) state.sched[d] = NOW;
  return fresh.length;
}

// ── 1) جدول الأسبوع ──────────────────────────────────────────────
const tz = encodeURIComponent(TZ);
const stale = (d, h) => !state.sched[d] || NOW - state.sched[d] > h * 3600e3;
const rangeErr = e => /season|league|from|to|date|required|parameter/i.test(JSON.stringify(e || ''));

// الخطة المجانية في API-Football لا تسمح إلا بثلاثة أيام: أمس واليوم والغد.
// عند ظهور رسالة «Free plans do not have access to this date» نحفظ النافذة المسموحة
// ولا نطلب أي يوم خارجها (كل طلب فاشل يُخصم من الـ100 اليومية).
state.window = null;
const freeErr = e => /free plans? do not have access/i.test(JSON.stringify(e || ''));
const learnWindow = e => {
  const m = JSON.stringify(e || '').match(/from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
  state.freePlan = true; state.freeAt = NOW;
  if (m) state.window = null;   // لا نحفظها — تتغيّر كل يوم
};
// يُعاد اختبار الأيام البعيدة مرة أسبوعياً (لو رُقّيت الخطة)
if (state.freePlan && NOW - (state.freeAt || 0) > 7 * 864e5) { state.freePlan = false; state.window = null; }
// ★ النافذة نسبية دائماً (أمس → الغد) — لا نعتمد التواريخ المحفوظة في رسالة الخطأ
//   (كانت تُحفظ ثابتة فتمنع جلب أي يوم جديد بعد مرور يومين ⇐ جدول فارغ)
const allowed = d => !state.freePlan || (d >= YESTERDAY && d <= TOMORROW);

if (!state.freePlan && !state.rangeBad && (stale(TODAY, R.weekHours) || DAYS.some(d => !state.sched[d]))) {
  // طلب واحد لكل الأسبوع وكل الدوريات
  const { res, errs } = await api(`fixtures?from=${DAYS[0]}&to=${DAYS[6]}&timezone=${tz}`);
  if (res) log(`📅 الأسبوع ${DAYS[0]} → ${DAYS[6]}: ${absorb(res, DAYS)} مباراة`);
  else if (errs && freeErr(errs)) { learnWindow(errs); state.rangeBad = true; log('ℹ️ خطة مجانية — نطلب أمس واليوم والغد فقط'); }
  else if (errs && rangeErr(errs)) { state.rangeBad = true; log('ℹ️ الخادم لا يقبل from/to بلا دوري — التحويل إلى طلب لكل يوم'); }
}
if (state.rangeBad || state.freePlan) {
  // طلب لكل يوم (كل الدوريات): اليوم كل 4 س، الغد كل 12 س، البقية مرة يومياً
  for (const d of DAYS) {
    if (!allowed(d)) continue;
    const i = DAYS.indexOf(d);
    const h = i === 0 ? R.todayHours : i === 1 ? R.tomorrowHours : R.otherDaysHours;
    if (!stale(d, h) || left() < 1) continue;
    const { res, errs } = await api(`fixtures?date=${d}&timezone=${tz}`);
    if (res) log(`📅 ${d}: ${absorb(res, [d])} مباراة`);
    else if (errs && freeErr(errs)) { learnWindow(errs); state.sched[d] = NOW; log(`ℹ️ ${d} خارج الخطة المجانية — لن يُطلب`); }
  }
  if (!state.rangeBadAt) state.rangeBadAt = NOW;
  if (NOW - state.rangeBadAt > 7 * 864e5) { state.rangeBad = false; state.rangeBadAt = 0; }
}
if (state.freePlan) log(`ℹ️ خطة مجانية: الأيام المطلوبة ${DAYS.filter(allowed).join('، ')}`);

// نتائج الأمس (للتوقعات): طلب واحد فقط في اليوم، وفقط إن بقيت مباراة بلا نتيجة نهائية
{
  const DONE = new Set(['FT', 'AET', 'PEN']);
  const missing = [...byId.values()].some(m => dayOf(m.ts * 1000) === YESTERDAY && !OFF.has(m.st)
    && (!DONE.has(m.st) || m.gh == null || m.ga == null));
  if (missing && (state.ydayFetched !== YESTERDAY || NOW - (state.ydayAt || 0) > 6 * 3600e3) && (state.ydayTries?.[YESTERDAY] || 0) < 3 && left() >= 1) {
    state.ydayTries = { [YESTERDAY]: (state.ydayTries?.[YESTERDAY] || 0) + 1 };
    const { res } = await api(`fixtures?date=${YESTERDAY}&timezone=${tz}`);
    if (res) { log(`🏁 نتائج الأمس ${YESTERDAY}: ${absorb(res, [YESTERDAY])} مباراة`); state.ydayFetched = YESTERDAY; state.ydayAt = NOW; }
  }
}

// تنظيف: أمس + 7 أيام
const KEEP = new Set([YESTERDAY, ...DAYS]);
for (const [id, m] of byId) if (!KEEP.has(dayOf(m.ts * 1000))) byId.delete(id);
for (const d of Object.keys(state.sched)) if (d < YESTERDAY) delete state.sched[d];

// ── 2) الأهمية (للبطاقات المميّزة في الرئيسية) ───────────────────
const score = m => (LEAGUES.get(m.lg)?.weight || 0)
  + 5 * ((BIG.has(m.h.n.toLowerCase()) ? 1 : 0) + (BIG.has(m.a.n.toLowerCase()) ? 1 : 0));
for (const d of KEEP) {
  const list = [...byId.values()].filter(m => dayOf(m.ts * 1000) === d);
  list.forEach(m => { m.score = score(m); m.imp = false; });
  list.filter(m => m.score >= cfg.importanceThreshold)
      .sort((a, b) => b.score - a.score || a.ts - b.ts)
      .slice(0, cfg.maxFeaturedPerDay || 6)
      .forEach(m => { m.imp = true; });
}

// ── 3) الشعارات + ألوان الأندية ───────────────────────────────────
let newLogos = 0;
async function saveLogo(file, src) {
  const p = `${DATA}/logos/${file}`;
  if (!src || fs.existsSync(p) || MOCK || newLogos >= 80) return;
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

// اللون الغالب «الملوّن» في الشعار (يتجاهل الأبيض والأسود والشفاف)
async function dominant(file) {
  if (!sharp || !fs.existsSync(file)) return null;
  try {
    const { data, info } = await sharp(file).resize(48, 48, { fit: 'inside' })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let total = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 200) continue;
      const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, l = (mx + mn) / 2;
      const s = mx === mn ? 0 : (l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn));
      total++;
      if (s < 0.28 || l < 0.12 || l > 0.88) continue;
      let h;
      const d = mx - mn, R = r / 255, G = g / 255, B = b / 255;
      if (mx === R) h = ((G - B) / d) % 6; else if (mx === G) h = (B - R) / d + 2; else h = (R - G) / d + 4;
      const bin = bins[Math.floor(((h * 60 + 360) % 360) / 30)];
      const w = s;
      bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
    }
    const best = bins.reduce((x, y) => (y.w > x.w ? y : x));
    if (!total || best.w < total * 0.06) return null;   // شعار أبيض/أسود في الغالب
    const hex = v => Math.round(v / best.w).toString(16).padStart(2, '0');
    return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
  } catch { return null; }
}
for (const m of byId.values()) {
  for (const t of [m.h, m.a]) {
    if (!(t.id in state.colors) && fs.existsSync(`${DATA}/logos/t${t.id}.png`)) {
      state.colors[t.id] = await dominant(`${DATA}/logos/t${t.id}.png`);
    }
  }
}
const colorOf = id => state.colors[id] || null;

// ── 4) صورة الإشعار: شعارا الفريقين على لونيهما ─────────────────
let newPosters = 0;
function tone(hex, l = 0.26) {
  if (!hex) return '#1c1c24';
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), cur = (mx + mn) / 2 || 0.0001;
  const k = l / cur;
  [r, g, b] = [r, g, b].map(v => Math.min(1, v * k));
  return '#' + [r, g, b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}
async function poster(m) {
  const file = `${DATA}/posters/m${m.id}.png`;
  if (!sharp || fs.existsSync(file) || newPosters >= 40) return fs.existsSync(file);
  const hL = `${DATA}/logos/t${m.h.id}.png`, aL = `${DATA}/logos/t${m.a.id}.png`, lL = `${DATA}/logos/l${m.lg}.png`;
  if (!fs.existsSync(hL) || !fs.existsSync(aL)) return false;
  try {
    const W = 1024, H = 512;
    const hc = tone(colorOf(m.h.id)), ac = tone(colorOf(m.a.id));
    const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="${ac}"/><stop offset="0.48" stop-color="#0a0a0e"/>
          <stop offset="0.52" stop-color="#0a0a0e"/><stop offset="1" stop-color="${hc}"/>
        </linearGradient>
        <radialGradient id="v" cx="0.5" cy="0.5" r="0.75">
          <stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.65"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/>
      <rect width="${W}" height="${H}" fill="url(#v)"/>
      <line x1="512" y1="70" x2="512" y2="442" stroke="#F5A623" stroke-opacity="0.55" stroke-width="3"/>
    </svg>`);
    const logo = async (f, s) => sharp(f).resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const layers = [
      { input: await logo(aL, 280), left: 116, top: 116 },   // الضيف يساراً
      { input: await logo(hL, 280), left: 628, top: 116 },   // المستضيف يميناً (عربي)
    ];
    if (fs.existsSync(lL)) {
      const lb = await sharp(lL).resize(88, 88, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha().png().toBuffer();
      const disc = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="116" height="116">' +
        '<circle cx="58" cy="58" r="56" fill="#0a0a0e" stroke="#F5A623" stroke-opacity="0.6" stroke-width="3"/></svg>');
      layers.push({ input: await sharp(disc).composite([{ input: lb, left: 14, top: 14 }]).png().toBuffer(),
        left: 454, top: 198 });
    }
    fs.mkdirSync(`${DATA}/posters`, { recursive: true });
    await sharp(bg).composite(layers).png({ compressionLevel: 9 }).toFile(file);
    newPosters++;
    return true;
  } catch (e) { log('poster:', e.message); return false; }
}
for (const m of [...byId.values()].filter(m => m.ts > nowS - 3 * 3600 && m.ts < nowS + 2 * 86400)) await poster(m);
for (const f of (fs.existsSync(`${DATA}/posters`) ? fs.readdirSync(`${DATA}/posters`) : [])) {
  if (!byId.has(Number(f.replace(/\D/g, '')))) fs.rmSync(`${DATA}/posters/${f}`);
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
  if (!GKEY || MOCK || (state.ai || 0) >= 60) return null;
  state.ai = (state.ai || 0) + 1;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GKEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.9 },
      }),
    });
    const j = await r.json();
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) { log('AI: رد فارغ', JSON.stringify(j).slice(0, 300)); return null; }
    return JSON.parse(txt);
  } catch (e) { log('AI:', e.message); return null; }
}

const missing = [...new Set([...byId.values()].flatMap(m => [m.h.n, m.a.n]).filter(n => !arName(n)))].slice(0, 120);
if (missing.length) {
  const tr = await gemini(
    'ترجم أسماء أندية ومنتخبات كرة القدم التالية إلى الاسم العربي الشائع في الإعلام الرياضي العربي. ' +
    'أعد كائن JSON فقط: المفتاح هو الاسم الأصلي حرفياً والقيمة هي الاسم العربي.\n' + JSON.stringify(missing));
  if (tr && typeof tr === 'object') for (const n of missing) if (typeof tr[n] === 'string' && tr[n].trim()) state.teamsAr[n] = tr[n].trim();
}

// ── 6) إعلانات المباريات (مجلد promos) ────────────────────────────
const promos = [];
const AD_RE = /^ad(?:_until-(\d{4})-(\d{2})-(\d{2}))?(?:_.*)?\.(jpe?g|png|webp)$/i;
const PROMO_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{1,2})-(\d{2})(?:_(.+))?\.(jpe?g|png|webp)$/i;
let promoChanged = false;
if (fs.existsSync('promos')) {
  fs.mkdirSync(`${DATA}/promos`, { recursive: true });
  for (const f of fs.readdirSync('promos')) {
    // إعلان عام (ليس مباراة): ad_اسم.jpg يظهر دائماً · ad_until-2026-11-30_اسم.jpg حتى نهاية ذلك اليوم
    const ad = f.match(AD_RE);
    if (ad) {
      if (ad[1] && localToTs(+ad[1], +ad[2], +ad[3], 23, 59) < nowS) continue;   // انتهت مدته
      const outName = `a${crypto.createHash('sha1').update(f).digest('hex').slice(0, 12)}.jpg`;
      if (!fs.existsSync(`${DATA}/promos/${outName}`)) {
        if (sharp) await sharp(`promos/${f}`).rotate().resize({ width: 1600, withoutEnlargement: true })
          .jpeg({ quality: 84, mozjpeg: true }).toFile(`${DATA}/promos/${outName}`);
        else fs.copyFileSync(`promos/${f}`, `${DATA}/promos/${outName}`);
        promoChanged = true;
      }
      promos.push({ img: `promos/${outName}`, ts: 0, fx: 0, title: '', ad: 1 });
      continue;
    }
    const mt = f.match(PROMO_RE);
    if (!mt) { if (!/\.md$/i.test(f)) log(`⚠️ اسم إعلان غير صحيح: ${f} (المطلوب 2026-10-20_21-45.jpg أو ad_اسم.jpg)`); continue; }
    const ts = localToTs(+mt[1], +mt[2], +mt[3], +mt[4], +mt[5]);
    if (ts < nowS - 2 * 3600) continue;                      // انتهى
    const id = crypto.createHash('sha1').update(f).digest('hex').slice(0, 12);
    const outName = `p${id}.jpg`;
    if (!fs.existsSync(`${DATA}/promos/${outName}`)) {
      if (sharp) await sharp(`promos/${f}`).rotate().resize({ width: 1280, withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true }).toFile(`${DATA}/promos/${outName}`);
      else fs.copyFileSync(`promos/${f}`, `${DATA}/promos/${outName}`);
      promoChanged = true;
    }
    // ربط الإعلان بالمباراة التي تنطلق في نفس الموعد (±10 دقائق) — الأهم أولاً
    // _m123456 في آخر الاسم = ربط مباشر بالمباراة رقم 123456 (يضعه تطبيق الإدارة تلقائياً)
    const fxId = Number(/^m(\d+)$/i.exec(mt[6] || '')?.[1] || 0);
    const cand = [...byId.values()].filter(m => Math.abs(m.ts - ts) <= 600 && !OFF.has(m.st))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const fx = (fxId && byId.get(fxId)) || cand[0];
    const title = (fxId ? '' : (mt[6] || '')).replace(/[-_]+/g, ' ').trim()
      || (fx ? `${arName(fx.h.n) || fx.h.n} × ${arName(fx.a.n) || fx.a.n}` : '');
    promos.push({ img: `promos/${outName}`, ts, fx: fx?.id || 0, title });
  }
  promos.sort((a, b) => (a.ad || 0) - (b.ad || 0) || a.ts - b.ts);   // المباريات أولاً ثم الإعلانات العامة
}

// ── 7) «صافرة البداية» — إشعار عند انطلاق المباريات (FCM — مجاني) ─
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
async function push(topic, title, body, data = {}, image = '') {
  if (MOCK) { log(`🔔 [تجريبي] ${topic}: ${title} — ${body}${image ? ' 🖼 ' + image : ''}`); return true; }
  if (!SA) { log('⚠️ FCM_SERVICE_ACCOUNT غير موجود — لن يُرسل إشعار'); return false; }
  try {
    const sa = JSON.parse(SA);
    _tok ??= await fcmToken(sa);
    const notification = { title, body };
    if (image) notification.image = image;
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${_tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        topic, notification,
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        android: { priority: 'HIGH', notification: { channel_id: 'totv_matches', sound: 'whistle' } },
        apns: { payload: { aps: { sound: 'default', 'mutable-content': 1 } }, fcm_options: image ? { image } : undefined },
      } }),
    });
    if (!r.ok) { log('FCM ❌', r.status, await r.text()); return false; }
    log(`🔔 أُرسل: ${title}`);
    return true;
  } catch (e) { log('FCM ❌', e.message); return false; }
}

const names = m => [arName(m.h.n) || m.h.n, arName(m.a.n) || m.a.n];

async function composeKickoff(group) {
  const top = group[0];
  const [H, A] = names(top);
  const L = LEAGUES.get(top.lg)?.ar || '';
  if (group.length === 1) {
    const late = Math.floor((nowS - top.ts) / 60);
    const fallback = late >= 8
      ? { title: `⚽ ${H} × ${A} — مباشر الآن`, body: `${L} — المباراة جارية منذ ${late} دقيقة، الحق بها على TOTV+ 🔥` }
      : { title: `🔔 صافرة البداية! ${H} × ${A}`, body: `${L} — انطلقت المباراة الآن، تابعها مباشرة على TOTV+ ⚽🔥` };
    if (late >= 8) return fallback;
    const ai = await gemini(
      'أنت معلّق ومحرر إشعارات لتطبيق بث رياضي عربي اسمه TOTV+. صافرة البداية انطلقت للتو. ' +
      'اكتب إشعاراً حماسياً قصيراً بروح المعلّق العربي.\n' +
      `المباراة: ${H} ضد ${A}\nالبطولة: ${L}\nالجولة: ${top.rd}\nالملعب: ${top.venue}\n` +
      'الشروط: عنوان ≤ 45 حرفاً يبدأ برمز 🔔 أو ⚽ ويذكر الفريقين، ونص ≤ 110 أحرف يدعو للمشاهدة الآن على TOTV+. ' +
      'ممنوع ذكر أي نتيجة أو أهداف أو ترتيب أو أخبار غير مذكورة هنا. أعد JSON فقط: {"title":"...","body":"..."}');
    const ok = ai && typeof ai.title === 'string' && typeof ai.body === 'string'
      && ai.title.length >= 8 && ai.title.length <= 70 && ai.body.length >= 8 && ai.body.length <= 160;
    return ok ? { title: ai.title.trim(), body: ai.body.trim() } : fallback;
  }
  const list = group.slice(0, 4).map(m => names(m).join(' × ')).join(' • ');
  return { title: `🔔 صافرة البداية في ${group.length} مباريات!`,
           body: `${list}${group.length > 4 ? ' والمزيد' : ''} — شاهد الآن على TOTV+ ⚽` };
}

if (TEST) {
  const sample = [...byId.values()].find(m => fs.existsSync(`${DATA}/posters/m${m.id}.png`));
  await push('admins', '🔔 تجربة صافرة البداية — TOTV+', 'نظام إشعارات المباريات يعمل بنجاح ⚽',
    { type: 'match' }, sample && FEED ? `${FEED}/posters/m${sample.id}.png` : '');
}

// المباريات التي انطلقت للتو (قبل 3 دقائق حتى 40 دقيقة)
// ★ جدولة GitHub «كل 5 دقائق» تتأخر كثيراً وقت الذروة (مباريات الساعة 10 مساءً)
//   حتى 20–30 دقيقة، فكانت النافذة القديمة (20 د) تُفوّت الإشعار كلياً.
const due = [...byId.values()].filter(m => !state.notified[m.id] && !OFF.has(m.st)
  && dayOf(m.ts * 1000) === TODAY && nowS >= m.ts - 180 && nowS <= m.ts + 40 * 60);
if (!SA && due.length) log(`⚠️ ${due.length} مباراة انطلقت لكن FCM_SERVICE_ACCOUNT غير موجود في Secrets — لا إشعار`);
const groups = new Map();
for (const m of due) { const k = m.ts; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
for (const g of groups.values()) {
  g.sort((a, b) => (b.score || 0) - (a.score || 0));
  if (state.notifyDay.count >= cfg.maxNotificationsPerDay) break;
  // مباراة أو اثنتان: إشعار لكل واحدة — ثلاث فأكثر في نفس الدقيقة: إشعار مجمّع
  const batches = g.length >= 3 ? [g] : g.map(m => [m]);
  for (const b of batches) {
    if (state.notifyDay.count >= cfg.maxNotificationsPerDay) break;
    const msg = await composeKickoff(b);
    const img = FEED && fs.existsSync(`${DATA}/posters/m${b[0].id}.png`) ? `${FEED}/posters/m${b[0].id}.png` : '';
    if (await push(cfg.notifyTopic || 'matches', msg.title, msg.body,
        { type: 'match', fixture: b[0].id }, img)) {
      for (const m of b) state.notified[m.id] = NOW;
      state.notifyDay.count++;
    }
  }
}
for (const [id, t] of Object.entries(state.notified)) if (NOW - t > 3 * 864e5) delete state.notified[id];

// ── 8) الكتابة والنشر ─────────────────────────────────────────────
const logo = f => fs.existsSync(`${DATA}/logos/${f}`) ? `logos/${f}` : '';
const matches = [...byId.values()].sort((a, b) => a.ts - b.ts);
const leaguesOut = Object.fromEntries(cfg.leagues.map(l => [l.id,
  { ar: l.ar, order: l.order, color: l.color || '', logo: logo(`l${l.id}.png`) }]));
const feed = {
  v: 2, updated: nowS, tz: TZ, today: TODAY,
  leagues: leaguesOut,
  channels: cfg.channels || {},
  promos,
  matches: matches.map(m => ({
    id: m.id, lg: m.lg, rd: m.rd, ts: m.ts, st: m.st,
    imp: !!m.imp, venue: m.venue,
    ...(['FT', 'AET', 'PEN'].includes(m.st) && m.gh != null && m.ga != null ? { gh: m.gh, ga: m.ga } : {}),
    poster: fs.existsSync(`${DATA}/posters/m${m.id}.png`) ? `posters/m${m.id}.png` : '',
    h: { id: m.h.id, n: m.h.n, ar: arName(m.h.n), logo: logo(`t${m.h.id}.png`), c: colorOf(m.h.id) || '' },
    a: { id: m.a.id, n: m.a.n, ar: arName(m.a.n), logo: logo(`t${m.a.id}.png`), c: colorOf(m.a.id) || '' },
    ch: cfg.overrides?.[m.id] ? [cfg.overrides[m.id]] : [],
  })),
};

writeJson(`${DATA}/matches.json`, { ...feed, matches });

const hash = crypto.createHash('sha1').update(JSON.stringify({ ...feed, updated: 0 })).digest('hex');
const heartbeat = NOW - (state.lastDeploy || 0) > 3 * 3600e3;
const changed = hash !== state.lastHash || newLogos > 0 || newPosters > 0 || promoChanged || heartbeat || TEST;
const keepalive = NOW - (state.lastKeepalive || 0) > 25 * 864e5;
if (changed) { state.lastHash = hash; state.lastDeploy = NOW; }
if (keepalive) state.lastKeepalive = NOW;

const status = {
  updated: nowS, quotaDay: state.quotaDay, used: state.used, remaining: state.remaining,
  mode: state.freePlan ? 'مجانية: أمس + اليوم + الغد' : state.rangeBad ? 'يوم بيوم' : 'طلب واحد للأسبوع',
  week: matches.filter(m => DAYS.includes(dayOf(m.ts * 1000))).length,
  today: matches.filter(m => dayOf(m.ts * 1000) === TODAY).length,
  promos: promos.length, notifiedToday: state.notifyDay.count, lastError: state.lastError || '', ai: state.ai || 0,
  sharp: !!sharp,
};
state.status = status;
writeJson(`${DATA}/state.json`, state);

if (changed) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  writeJson(`${OUT}/matches.json`, feed);
  writeJson(`${OUT}/state.json`, state);
  writeJson(`${OUT}/status.json`, status);
  for (const dir of ['logos', 'posters', 'promos']) {
    if (fs.existsSync(`${DATA}/${dir}`)) fs.cpSync(`${DATA}/${dir}`, `${OUT}/${dir}`, { recursive: true });
  }
  // لا ننشر إعلانات منتهية
  const live = new Set(promos.map(p => p.img.split('/')[1]));
  if (fs.existsSync(`${OUT}/promos`)) for (const f of fs.readdirSync(`${OUT}/promos`)) if (!live.has(f)) fs.rmSync(`${OUT}/promos/${f}`);
  if (fs.existsSync('scripts/status.html')) fs.copyFileSync('scripts/status.html', `${OUT}/index.html`);
  fs.writeFileSync(`${OUT}/.nojekyll`, '');
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nkeepalive=${keepalive}\n`);
}
log(`انتهى — نشر: ${changed ? 'نعم' : 'لا تغيير'} | طلبات اليوم ${state.used} | شعارات ${newLogos} | صور إشعار ${newPosters} | إعلانات ${promos.length}`);
