// ════════════════════════════════════════════════════════════════════
//  TOTV+ Catalog — نسخة من قوائم السيرفر الافتراضي على GitHub Pages
//
//  لماذا؟ المستخدم الجديد (غير المشترك) كان يجلب قوائم الأفلام والمسلسلات من
//  سيرفر Xtream مباشرة ⇐ بطء شديد في أول فتح + ضغط على السيرفر لكل مستخدم.
//  الآن: هذا السكربت يجلبها مرة كل 6 ساعات وينشرها ملفات صغيرة مضغوطة على Pages
//  ⇐ تظهر الواجهة فوراً لكل الزوار، وصفر طلبات على السيرفر منهم.
//
//  ويضيف خلفيات وبوسترات عالية الجودة من TMDB لأحدث الأفلام والمسلسلات
//  (يعمل هنا على خوادم GitHub — لا يتأثر بحجب TMDB في بعض الدول).
//
//  الأسرار (Settings ← Secrets ← Actions):
//    XTREAM_HOST  مثل http://example.com:8080      XTREAM_USER   XTREAM_PASS
//    TMDB_KEY     (اختياري) مفتاح TMDB v3 للخلفيات
//  يكتب في data/catalog/ (محفوظ بين التشغيلات) وupdate.mjs ينشره مع المباريات.
// ════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* بدونها: لا نسخ للصور */ }

const DATA = process.env.DATA_DIR || 'data';
const DIR = `${DATA}/catalog`;
const HOST = (process.env.XTREAM_HOST || '').trim().replace(/\/+$/, '');
const USER = (process.env.XTREAM_USER || '').trim();
const PASS = (process.env.XTREAM_PASS || '').trim();
const TMDB = (process.env.TMDB_KEY || '').trim();
const EVERY_H = Number(process.env.CATALOG_HOURS || 12);
const FORCE = String(process.env.CATALOG_FORCE || '') === 'true';
const log = (...a) => console.log('[catalog]', ...a);

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };

// ★ v3.6.1: السيرفر يحجب خوادم GitHub (403) ⇐ المصدر الاحتياطي: النسخة الخام التي يرفعها هاتف الإدارة
const CDN = (process.env.CDN_BASE || '').trim().replace(/\/+$/, '');
if ((!HOST || !USER || !PASS) && !CDN) { log('لا مصدر للقوائم (XTREAM_* أو CDN_BASE) — تخطٍّ'); process.exit(0); }
const st = readJson(`${DATA}/catalog_state.json`, {});
if (!FORCE && st.at && Date.now() - st.at < EVERY_H * 3600e3) { log('حديث — لا حاجة للتحديث'); process.exit(0); }

async function api(action, timeoutMs = 90000) {
  const u = `${HOST}/player_api.php?username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}&action=${action}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(u, { signal: ac.signal, headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' } });
    if (!r.ok) throw new Error(`${action} HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`${action}: ليست قائمة`);
    return j;
  } finally { clearTimeout(t); }
}

const pick = (o, keys) => { const x = {}; for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') x[k] = o[k]; return x; };
const ADULT = /(xxx|adult|\+18|18\+|porn)/i;

let live, vod, series, lc, vc, sc;
async function fromXtream() {
  [lc, vc, sc] = await Promise.all([api('get_live_categories', 30000), api('get_vod_categories', 30000), api('get_series_categories', 30000)]);
  [live, vod, series] = await Promise.all([api('get_live_streams'), api('get_vod_streams'), api('get_series')]);
}
async function fromRaw() {
  const get = async (f) => {
    const r = await fetch(`${CDN}/catalog/raw/${f}?b=${Date.now()}`);
    if (!r.ok) throw new Error(`raw/${f} HTTP ${r.status}`);
    return r.json();
  };
  const [m, s2, l, c] = await Promise.all([get('movies.json'), get('series.json'), get('live.json'), get('cats.json')]);
  if (!Array.isArray(m) || !Array.isArray(s2)) throw new Error('raw: ليست قوائم');
  vod = m; series = s2; live = Array.isArray(l) ? l : [];
  lc = c.live || []; vc = c.movie || []; sc = c.series || [];
}
try {
  if (!HOST || !USER || !PASS) throw new Error('no xtream secrets');
  await fromXtream();
  log('المصدر: سيرفر Xtream');
} catch (e) {
  log('السيرفر غير متاح من هنا:', e.message, '— نجرب النسخة الخام من هاتف الإدارة');
  try {
    if (!CDN) throw new Error('CDN_BASE غير مضبوط');
    await fromRaw();
    log('المصدر: catalog/raw على موقعنا');
  } catch (e2) {
    log('فشل الجلب — نُبقي النسخة السابقة:', e2.message);
    writeJson(`${DATA}/catalog_state.json`, { ...st, lastError: String(e2.message), errorAt: Date.now() });
    process.exit(0);
  }
}

const badCat = new Set([...lc, ...vc, ...sc].filter(c => ADULT.test(c.category_name || '')).map(c => String(c.category_id)));
const ok = (x) => !badCat.has(String(x.category_id)) && !ADULT.test(x.name || '');

const liveOut = live.filter(ok).map(x => pick(x, ['stream_id', 'name', 'stream_icon', 'category_id', 'epg_channel_id', 'num']));
const vodOut = vod.filter(ok).map(x => pick(x, ['stream_id', 'name', 'stream_icon', 'category_id', 'rating', 'rating_5based', 'added', 'container_extension']));
const serOut = series.filter(ok).map(x => pick(x, ['series_id', 'name', 'cover', 'category_id', 'rating', 'rating_5based', 'last_modified', 'genre', 'releaseDate']));
const cats = {
  live: lc.filter(c => !badCat.has(String(c.category_id))).map(c => pick(c, ['category_id', 'category_name'])),
  movie: vc.filter(c => !badCat.has(String(c.category_id))).map(c => pick(c, ['category_id', 'category_name'])),
  series: sc.filter(c => !badCat.has(String(c.category_id))).map(c => pick(c, ['category_id', 'category_name'])),
};

// ── خلفيات TMDB لأحدث العناوين (مع ذاكرة كي لا نكرر الطلبات) ──
const cache = readJson(`${DATA}/tmdb_cache.json`, {});
const clean = (n) => String(n || '')
  .replace(/^\s*(\|[^|]*\||[A-Z]{2,3}\s*[-:|]\s*)/i, '')
  .replace(/\[[^\]]*\]|\{[^}]*\}/g, '')
  .replace(/\b(4K|FHD|HD|SD|UHD|HEVC|x265|MULTI|SUB|DUB|مدبلج|مترجم)\b/gi, '')
  .replace(/\s+/g, ' ').trim();
const yearOf = (n) => (String(n).match(/\((19|20)\d{2}\)/) || [''])[0].replace(/\D/g, '');
async function tmdb(kind, name) {
  const key = `${kind}:${name}`;
  if (cache[key] !== undefined) return cache[key];
  const y = yearOf(name);
  const q = clean(name).replace(/\((19|20)\d{2}\)/, '').trim();
  if (!q) return (cache[key] = null);
  const u = `https://api.themoviedb.org/3/search/${kind}?api_key=${TMDB}&language=ar&query=${encodeURIComponent(q)}`
    + (y ? `&${kind === 'movie' ? 'year' : 'first_air_date_year'}=${y}` : '');
  try {
    const r = await fetch(u);
    if (!r.ok) return null;                        // لا نخزّن الأخطاء المؤقتة
    const j = await r.json();
    const h = (j.results || [])[0];
    cache[key] = h ? { bd: h.backdrop_path || '', ps: h.poster_path || '', tid: h.id, ov: (h.overview || '').slice(0, 220) } : null;
  } catch { return null; }
  return cache[key];
}
async function enrich(list, kind, sortKey, n) {
  if (!TMDB) return 0;
  const top = [...list].sort((a, b) => Number(b[sortKey] || 0) - Number(a[sortKey] || 0)).slice(0, n);
  let hits = 0;
  for (let i = 0; i < top.length; i += 8) {
    await Promise.all(top.slice(i, i + 8).map(async (x) => {
      const t = await tmdb(kind, x.name);
      if (!t) return;
      if (t.bd) { x.bd = `https://image.tmdb.org/t/p/w780${t.bd}`; hits++; }
      if (t.ps) x.ps = `https://image.tmdb.org/t/p/w342${t.ps}`;
      if (t.tid) x.tmdb_id = t.tid;
      if (t.ov) x.ov = t.ov;
    }));
  }
  return hits;
}
const mh = await enrich(vodOut, 'movie', 'added', 400);
const sh = await enrich(serOut, 'tv', 'last_modified', 250);

// ── art.json: خلفيات وبوسترات حسب اسم العنوان — يستخدمها التطبيق لتجميل محتوى أي سيرفر (حتى للمشتركين) ──
const norm = (n) => clean(n).toLowerCase().replace(/\((19|20)\d{2}\)/g, '').replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();
const art = {};
for (const x of [...vodOut, ...serOut]) {
  if (!x.bd) continue;
  const k = norm(x.name);
  if (k && !art[k]) art[k] = [x.bd, x.ps || '', x.ov || ''];
}

// ════════════════════════════════════════════════════════════════════
//  ★ v3.6 home.json — «الرئيسية» في ملف صغير (~60KB) يظهر فوراً للمستخدم الجديد
//   • أحدث/أعلى تقييماً/اختيارات بخلفيات/أحدث المسلسلات/أكبر التصنيفات — نفس صفوف التطبيق
//   • صورها منسوخة عندنا (webp صغيرة) ⇐ لا طلب على سيرفر الصور ولا على TMDB (المحجوب أحياناً)
//   • القوائم الكاملة تُنزَّل لاحقاً فقط عند فتح الأفلام/البحث، ومرة واحدة حتى تتغير (index.json → ver)
// ════════════════════════════════════════════════════════════════════
const num = (v) => Number(v || 0);
const rate = (x) => { const r5 = Number(x.rating_5based || 0); return r5 > 0 ? r5 * 2 : Number(x.rating || 0); };
const hasImg = (x) => !!(x.stream_icon || x.cover || x.ps);
const mvSorted = vodOut.filter(hasImg).sort((a, b) => num(b.added) - num(a.added));
const srSorted = serOut.filter(hasImg).sort((a, b) => num(b.last_modified) - num(a.last_modified));
const pickM = new Map(), pickS = new Map();
const addM = (l) => l.forEach((x) => pickM.set(String(x.stream_id), x));
const addS = (l) => l.forEach((x) => pickS.set(String(x.series_id), x));
addM(mvSorted.slice(0, 40));
addM(mvSorted.slice(0, 500).filter((x) => rate(x) > 0).sort((a, b) => rate(b) - rate(a)).slice(0, 30));
addM(mvSorted.slice(0, 400).filter((x) => x.bd && rate(x) >= 6).slice(0, 30));
addS(srSorted.slice(0, 40));
addS(srSorted.slice(0, 250).filter((x) => x.bd && rate(x) >= 6).slice(0, 20));
const groupTop = (list, n, per) => {
  const by = new Map();
  for (const x of list) { const c = String(x.category_id || ''); if (c) { if (!by.has(c)) by.set(c, []); by.get(c).push(x); } }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, n).map(([c, l]) => [c, l.slice(0, per)]);
};
for (const [, l] of groupTop(srSorted, 6, 15)) addS(l);
for (const [, l] of groupTop(mvSorted, 8, 6)) addM(l);
const countBy = (list) => { const o = {}; for (const x of list) { const c = String(x.category_id || ''); if (c) o[c] = (o[c] || 0) + 1; } return o; };

// ── نسخ الصور (webp) — الجديدة فقط، والقديمة من الذاكرة بين التشغيلات ──
const IMG = `${DIR}/img`;
const imgMap = readJson(`${DATA}/catalog_img.json`, {});
let newImgs = 0;
async function mirror(url, w, h) {
  if (!sharp || !url || !/^https?:\/\//.test(url)) return '';
  const id = crypto.createHash('sha1').update(`${url}|${w}`).digest('hex').slice(0, 16);
  const rel = `catalog/img/${id}.webp`;
  if (imgMap[id] && fs.existsSync(`${IMG}/${id}.webp`)) return rel;
  if (imgMap[id] === false || newImgs >= 700) return '';
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } }).finally(() => clearTimeout(t));
    if (!r.ok) { imgMap[id] = false; return ''; }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(IMG, { recursive: true });
    await sharp(buf).resize(w, h, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 72 }).toFile(`${IMG}/${id}.webp`);
    imgMap[id] = 1; newImgs++;
    return rel;
  } catch { imgMap[id] = false; return ''; }
}
async function mirrorAll(items, iconKey) {
  for (let i = 0; i < items.length; i += 8) {
    await Promise.all(items.slice(i, i + 8).map(async (x) => {
      const p = await mirror(x[iconKey] || x.ps, 240, 360);
      if (p) x[iconKey] = p;
      if (x.bd) { const b = await mirror(x.bd, 720, 405); if (b) x.bd = b; }
    }));
  }
}
const homeM = [...pickM.values()].map((x) => ({ ...x }));
const homeS = [...pickS.values()].map((x) => ({ ...x }));
await mirrorAll(homeM, 'stream_icon');
await mirrorAll(homeS, 'cover');
// صور لم تعد مستخدمة ⇐ تُحذف (المخزن يبقى صغيراً)
const used = new Set([...homeM, ...homeS].flatMap((x) => [x.stream_icon, x.cover, x.bd]).filter((u) => String(u || '').startsWith('catalog/img/'))
  .map((u) => u.slice(12, 28)));
if (fs.existsSync(IMG)) for (const f of fs.readdirSync(IMG)) if (!used.has(f.slice(0, 16))) fs.rmSync(`${IMG}/${f}`);
writeJson(`${DATA}/catalog_img.json`, imgMap);

const home = {
  updated: Math.floor(Date.now() / 1000),
  movies: homeM, series: homeS,
  counts: { movie: countBy(vodOut), series: countBy(serOut) },
  total: { movies: vodOut.length, series: serOut.length, live: liveOut.length },
};

writeJson(`${DIR}/art.json`, art);
writeJson(`${DIR}/live.json`, liveOut);
writeJson(`${DIR}/movies.json`, vodOut);
writeJson(`${DIR}/series.json`, serOut);
writeJson(`${DIR}/cats.json`, cats);
writeJson(`${DIR}/home.json`, home);
writeJson(`${DATA}/tmdb_cache.json`, cache);
const ver = {};
for (const f of ['movies', 'series', 'live', 'cats', 'art', 'home']) {
  ver[f] = crypto.createHash('sha1').update(fs.readFileSync(`${DIR}/${f}.json`)).digest('hex').slice(0, 10);
}
const index = { updated: Math.floor(Date.now() / 1000), live: liveOut.length, movies: vodOut.length, series: serOut.length,
  backdrops: { movies: mh, series: sh }, images: used.size, ver };
writeJson(`${DIR}/index.json`, index);
fs.writeFileSync(`${DATA}/catalog_fresh`, '1');
writeJson(`${DATA}/catalog_state.json`, { at: Date.now(), ...index });
log(`تم — قنوات ${liveOut.length} · أفلام ${vodOut.length} · مسلسلات ${serOut.length} · خلفيات ${mh}+${sh} · صور الرئيسية ${used.size} (جديدة ${newImgs})`);
