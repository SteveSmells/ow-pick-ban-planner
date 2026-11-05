// Overwatch draft data updater.
// Runs inside GitHub Actions (Node 20+, no dependencies) and writes data/meta.json,
// which index.html reads. Every number and sentence the page shows comes from here.
//
// Sources:
//   OverFast API   official Blizzard win/pick/ban rates (by rank and map), roster, maps, roles
//   Counterwatch   hero-vs-hero counter ratings, season number
//   Blizzard       latest official patch notes
//   owperks.com    perk descriptions with community vote share
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OF = 'https://overfast-api.tekrop.fr';
const CW = 'https://www.counterwatch.gg';
const PATCH_URL = 'https://overwatch.blizzard.com/en-us/news/patch-notes/';
const PERKS_URL = 'https://owperks.com';
const OUT = 'data/meta.json';
const UA = 'Mozilla/5.0 (compatible; ow-draft-personal/1.0; personal GitHub Pages app, one run per day)';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const nk = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const cap = s => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const log = (...a) => console.log(...a);

async function http(url, { json = false, tries = 4 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html,*/*' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) {
        last = new Error('HTTP ' + r.status + ' for ' + url);
        await sleep(Math.max((+r.headers.get('retry-after') || 0) * 1000, 1500 * (i + 1)));
        continue;
      }
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status + ' for ' + url), { fatal: true });
      return json ? await r.json() : await r.text();
    } catch (e) {
      last = e;
      if (e.fatal) break;
      await sleep(1000 * (i + 1));
    }
  }
  throw last;
}

// ---------- text helpers ----------
function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&rsquo;|&#8217;/g, '’')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
export function toLines(html) {
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<img[^>]*>/gi, ' ');
  t = t.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol|table|header|footer|nav|main|aside|blockquote|dd|dt)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(t).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
export const flat = html => toLines(html).join(' ');
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameAlt = names => [...new Set(names)].sort((a, b) => b.length - a.length).map(reEsc).join('|');
const LABEL = { 'Wins the 1v1': 'duel', 'Team pressure': 'team', 'Mixed threat': 'mixed' };

// ---- Counterwatch: every entry is a link to a hero page, so read the links ----
function heroAnchors(html) {
  const out = [];
  const re = /<a\b[^>]*?href=["']?(?:https?:\/\/[^"'\s>]*)?\/stats\/overwatch\/heroes\/([a-z0-9-]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) out.push({ slug: m[1], text: flat(m[2]) });
  return out;
}
const SIGNED = /(?:^|\s)([+\-−]\d+(?:\.\d+)?)(?![\d.])/;
// Counter page: every hero ranked against the target. Positive = that hero counters the target, negative = target beats it.
export function parseCountersPage(html, selfSlug) {
  const seen = new Set(), out = [];
  for (const a of heroAnchors(html)) {
    if (a.slug === selfSlug || seen.has(a.slug)) continue;
    const m = a.text.match(SIGNED);
    if (!m) continue;
    seen.add(a.slug);
    const l = (a.text.match(/(Wins the 1v1|Team pressure|Mixed threat)/) || [])[1];
    out.push({ slug: a.slug, r: parseFloat(m[1].replace('−', '-')), l: LABEL[l] || null });
  }
  return out;
}
// ---- Perks (owperks.com lists every hero on one page) ----
// "<Hero> View full statistics Minor Perks Community Choice <Name> 72% <text> ... Major Perks Community Choice ..."
export function parsePerks(html, names) {
  let f = flat(html);
  const cut = f.search(/BEST OVERWATCH HERO PERKS OW PERKS|©/);
  if (cut > 0) f = f.slice(0, cut);
  const head = new RegExp('(?<![\\p{L}\\d])(?<n>' + nameAlt(names) + ')(?: New hero)? View full statistics', 'gu');
  const marks = [...f.matchAll(head)].map(m => ({ n: m.groups.n, i: m.index, end: m.index + m[0].length }));
  const one = txt => [...txt.matchAll(/Community Choice (?<name>.+?) (?:(?:New|Updated) )?(?<pct>\d{1,3})% (?<desc>.+?)(?= Community Choice |$)/g)]
    .map(m => ({ n: m.groups.name.trim(), p: +m.groups.pct, d: m.groups.desc.trim().slice(0, 220) }))
    .filter(p => p.n && p.d.length > 8 && p.p <= 100);
  const out = {};
  marks.forEach((mk, k) => {
    let seg = f.slice(mk.end, k + 1 < marks.length ? marks[k + 1].i : f.length).replace(/\s*(?:Tank|Damage|Support) Heroes\s*$/, '');
    const mi = seg.search(/Minor Perks/), ma = seg.search(/Major Perks/);
    if (mi < 0 || ma < 0) return;
    const minor = one(seg.slice(mi, ma)), major = one(seg.slice(ma));
    if (minor.length || major.length) out[mk.n] = { minor, major };
  });
  return out;
}

// Latest official patch notes: first patch on the page, hero section only.
// List items come back as "• text" lines so the page can tell change bullets from ability headings.
export function parsePatch(html, heroes) {
  const lines = toLines(html.replace(/<li\b[^>]*>/gi, '<li>• '));
  const titleRe = /Overwatch Retail Patch Notes/i;
  const ti = lines.findIndex(l => titleRe.test(l));
  if (ti < 0) throw new Error('patch notes title not found');
  const nextTi = lines.findIndex((l, i) => i > ti && titleRe.test(l));
  const stop = nextTi < 0 ? lines.length : nextTi;
  const title = lines[ti];
  const dm = title.match(/([A-Z][a-z]+)\.? (\d{1,2}), (\d{4})/);
  const date = dm ? new Date(`${dm[1]} ${dm[2]}, ${dm[3]} 12:00:00 UTC`).toISOString().slice(0, 10) : null;
  let s = lines.findIndex((l, i) => i > ti && i < stop && /^Hero Updates$/i.test(l));
  if (s < 0) return { title, date, heroes: {} };
  let e = lines.findIndex((l, i) => i > s && i < stop && /^(Stadium Updates|Bug Fixes|Stadium)$/i.test(l));
  if (e < 0) e = stop;
  const byName = new Map(heroes.map(h => [nk(h.name), h]));
  const out = {};
  let cur = null, inDev = false;
  for (let i = s + 1; i < e; i++) {
    const l = lines[i];
    const h = l.length <= 22 ? byName.get(nk(l)) : null;
    if (h) { cur = out[h.key] = { lines: [], dev: '' }; inDev = false; continue; }
    if (/^(Tank|Damage|Support)$/i.test(l) || !cur) continue;
    if (/^Developer Comments:/i.test(l)) { cur.dev = l.replace(/^Developer Comments:\s*/i, '').slice(0, 700); inDev = true; continue; }
    if (inDev && !l.startsWith('• ') && l.length > 60) { cur.dev = (cur.dev + ' ' + l).slice(0, 700); continue; }   // later paragraphs of the same comment
    inDev = false;
    if (cur.lines.length < 40) cur.lines.push(l.slice(0, 240));
  }
  Object.keys(out).forEach(k => { if (!out[k].lines.length && !out[k].dev) delete out[k]; });
  return { title, date, heroes: out };
}

// ---------- OpenAPI helpers ----------
function resolveEnum(spec, s) {
  if (!s) return null;
  if (s.$ref) return resolveEnum(spec, spec.components?.schemas?.[s.$ref.split('/').pop()]);
  if (s.enum) return s.enum;
  for (const k of ['anyOf', 'oneOf', 'allOf']) if (s[k]) for (const x of s[k]) { const e = resolveEnum(spec, x); if (e) return e; }
  return null;
}
function findParam(spec, p, re) {
  const params = spec.paths?.[p]?.get?.parameters || [];
  const prm = params.find(x => re.test(x.name));
  return prm ? { name: prm.name, values: resolveEnum(spec, prm.schema) } : null;
}
const asList = j => Array.isArray(j) ? j : (j?.data || j?.heroes || j?.results || []);

// ---------- main ----------
async function readPrev() {
  try { return JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { return null; }
}

export async function main() {
  const prev = await readPrev();
  const meta = { updated: new Date().toISOString(), sources: {} };
  const ok = (k, count, note) => { meta.sources[k] = { ok: true, at: new Date().toISOString(), count, note: note || '' }; log('OK  ', k, count, note || ''); };
  const bad = (k, e) => { meta.sources[k] = { ok: false, at: new Date().toISOString(), error: String(e.message || e).slice(0, 300) }; log('FAIL', k, e.message || e); };

  // 1. OverFast roster (required)
  const [hs, ms, rs] = await Promise.all([http(OF + '/heroes', { json: true }), http(OF + '/maps', { json: true }), http(OF + '/roles', { json: true })]);
  const roster = asList(hs).filter(h => h.key && h.name && h.role).map(h => ({ key: h.key, name: h.name, role: String(h.role).toLowerCase(), portrait: h.portrait || '' }));
  if (roster.length < 20) throw new Error('OverFast returned only ' + roster.length + ' heroes; keeping previous data');
  meta.heroes = roster;
  meta.roles = asList(rs).map(r => ({ key: r.key, name: r.name, description: r.description || '', icon: r.icon || '' }));
  const allMaps = asList(ms);
  ok('roster', roster.length, allMaps.length + ' maps');

  // 2. Official rates by rank and by map (OverFast mirrors Blizzard's hero statistics page)
  try {
    const spec = await http(OF + '/openapi.json', { json: true });
    const P = '/heroes/stats';
    const pPlat = findParam(spec, P, /^platform$/), pMode = findParam(spec, P, /^gamemode$/), pReg = findParam(spec, P, /^region$/),
      pDiv = findParam(spec, P, /division|tier|rank/i), pMap = findParam(spec, P, /^map$/);
    const pick = (prm, want) => (prm && prm.values ? (prm.values.includes(want) ? want : prm.values[0]) : want);
    const base = new URLSearchParams();
    if (pPlat) base.set(pPlat.name, pick(pPlat, 'pc'));
    if (pMode) base.set(pMode.name, pick(pMode, 'competitive'));
    const region = process.env.REGION || 'americas';
    if (pReg) base.set(pReg.name, pick(pReg, region));
    meta.region = pReg ? base.get(pReg.name) : null;
    const divValues = pDiv && pDiv.values ? pDiv.values.map(String) : [];
    const hasAll = divValues.includes('all');
    const divs = hasAll ? divValues : ['all', ...divValues];
    const rates = {}, mapRates = {};
    const fetchRates = async (extra, withBan = true) => {
      const q = new URLSearchParams(base);
      Object.entries(extra).forEach(([k, v]) => v != null && q.set(k, v));
      const j = await http(OF + P + '?' + q, { json: true });
      const o = {};
      asList(j).forEach(x => {
        const k = x.hero || x.key; if (!k) return;
        if (typeof x.winrate === 'number') o[k] = [+x.winrate.toFixed(2), +(x.pickrate ?? 0).toFixed(2)];
        if (withBan) o[k].push(typeof x.banrate === 'number' ? +x.banrate.toFixed(2) : null);
      });
      return o;
    };
    for (const d of divs) {
      try { rates[d] = await fetchRates(d === 'all' && !hasAll ? {} : { [pDiv.name]: d }); } catch (e) { log('  rank', d, 'failed:', e.message); }
      await sleep(400);
    }
    if (!rates.all || !Object.keys(rates.all).length) throw new Error('no all-ranks rates returned');
    meta.divisions = divs.filter(d => rates[d] && Object.keys(rates[d]).length).map(d => ({ key: d, label: d === 'all' ? 'All ranks' : cap(d) }));
    // competitive map list = the map values Blizzard's statistics page supports
    const mapVals = pMap && pMap.values ? pMap.values.map(String).filter(v => !/^all/.test(v)) : [];
    const byNk = new Map(allMaps.map(m => [nk(m.name), m]));
    meta.maps = [];
    const noStats = [];
    for (const v of mapVals) {
      const m = byNk.get(nk(v)) || null;
      const key = nk(m ? m.name : v);
      try {
        const r = await fetchRates({ [pMap.name]: v }, false);
        if (Object.keys(r).length) {
          mapRates[key] = r;
          meta.maps.push({ key, name: m ? m.name : cap(v), modes: m ? m.gamemodes || [] : [], img: m ? m.screenshot || '' : '' });
        } else noStats.push(v);
      } catch (e) { noStats.push(v); }   // HTTP 400 = not in the competitive map pool right now
      await sleep(400);
    }
    log('  maps with competitive stats:', meta.maps.length, '| skipped (not in the competitive pool):', noStats.length);
    meta.knownMaps = allMaps.map(m => nk(m.name));
    meta.rates = rates; meta.mapRates = mapRates;
    ok('rates', Object.keys(rates).length, `${Object.keys(mapRates).length} maps, region ${meta.region || 'default'}`);
  } catch (e) { bad('rates', e); }

  const names = roster.map(h => h.name);
  const byNameNk = new Map(roster.map(h => [nk(h.name), h]));
  const heroBy = new Map(roster.flatMap(h => [[nk(h.key), h], [nk(h.name), h]]));
  const bySlug = slug => heroBy.get(nk(slug));

  // 3. Counterwatch: season and the counter matrix (ratings under 1 point are noise and are left out)
  try {
    const list = await http(CW + '/stats/overwatch/heroes');
    const slugs = [...new Set([...list.matchAll(/\/stats\/overwatch\/heroes\/([a-z0-9-]+)/g)].map(m => m[1]))].filter(x => !/^opengraph/i.test(x));
    if (slugs.length < 15) throw new Error('only found ' + slugs.length + ' hero links on Counterwatch');
    try {
      const tl = flat(await http(CW + '/stats/overwatch/tier-list'));
      const sm = tl.match(/Tier List\W*Season (\d{1,3})/i) || tl.match(/Season (\d{1,3})/);
      if (sm && +sm[1] >= 1 && +sm[1] <= 99) meta.season = { number: +sm[1], source: 'counterwatch.gg' };
    } catch (e) { log('  season lookup failed:', e.message); }
    const counters = {};
    let counterPages = 0, shown = 0;
    for (const slug of slugs) {
      const h = bySlug(slug);
      if (!h) { log('  no roster match for Counterwatch slug', slug); continue; }
      try {
        const html = await http(CW + '/stats/overwatch/counters/' + slug);
        const es = parseCountersPage(html, slug);
        if (es.length) {
          counters[h.key] = {};
          es.forEach(x => { const o = bySlug(x.slug); if (o && o.key !== h.key && Math.abs(x.r) >= 1) counters[h.key][o.key] = [x.r, x.l]; });
          counterPages++;
        } else if (shown++ < 2) log('  DIAG counters page found nothing for', slug, '| links:', heroAnchors(html).length, '| text starts:', flat(html).slice(0, 400));
      } catch (e) { log('  counters page', slug, e.message); }
      await sleep(700);
    }
    if (counterPages < 10) throw new Error(`parsed only ${counterPages} counter pages; page layout may have changed`);
    meta.counters = counters;
    ok('counterwatch', counterPages, `season ${meta.season ? meta.season.number : 'unknown'}`);
  } catch (e) { bad('counterwatch', e); }

  // 4. Blizzard patch notes
  try {
    const p = parsePatch(await http(PATCH_URL), roster);
    const n = Object.keys(p.heroes).length;
    if (!n) throw new Error('no hero changes found in the latest patch notes');
    meta.patch = { date: p.date, heroes: p.heroes };
    ok('patchnotes', n, p.date || '');
  } catch (e) { bad('patchnotes', e); }

  // 5. Perks (community votes)
  try {
    const html = await http(PERKS_URL + '/en');
    const perks = {};
    Object.entries(parsePerks(html, names)).forEach(([n, v]) => { const hero = byNameNk.get(nk(n)); if (hero) perks[hero.key] = v; });
    const n = Object.keys(perks).length;
    if (n < 10) { log('  DIAG perks page text starts:', flat(html).slice(0, 500)); throw new Error('only parsed perks for ' + n + ' heroes'); }
    meta.perks = perks;
    ok('perks', n, 'community vote share');
  } catch (e) { bad('perks', e); }

  // Keep the last good copy of any section whose source failed today
  const keep = (src, fields) => {
    if (meta.sources[src] && meta.sources[src].ok === false && prev) {
      fields.forEach(f => { if (prev[f] !== undefined) meta[f] = prev[f]; });
      meta.sources[src].stale = true;
      meta.sources[src].staleAt = prev.sources && prev.sources[src] ? prev.sources[src].at : prev.updated;
    }
  };
  keep('rates', ['rates', 'mapRates', 'divisions', 'maps', 'knownMaps', 'region']);
  keep('counterwatch', ['counters', 'season']);
  keep('patchnotes', ['patch']);
  keep('perks', ['perks']);
  if (!meta.rates && !meta.divisions) throw new Error('no rates available at all; keeping previous file');

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(meta));
  log('Wrote', OUT, (JSON.stringify(meta).length / 1024).toFixed(0) + ' KB');
  const failed = Object.entries(meta.sources).filter(([, v]) => !v.ok).map(([k]) => k);
  if (failed.length) log('::warning::Some sources failed and were kept from the previous run: ' + failed.join(', '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('::error::' + (e.message || e)); process.exit(1); });
}
// Overwatch draft data updater.
// Runs inside GitHub Actions (Node 20+, no dependencies) and writes data/meta.json,
// which index.html reads. Every number and sentence the page shows comes from here.
//
// Sources:
//   OverFast API   official Blizzard win/pick/ban rates (by rank and map), roster, maps, roles
//   Counterwatch   hero-vs-hero counter ratings, season number
//   Blizzard       latest official patch notes
//   owperks.com    perk descriptions with community vote share
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OF = 'https://overfast-api.tekrop.fr';
const CW = 'https://www.counterwatch.gg';
const PATCH_URL = 'https://overwatch.blizzard.com/en-us/news/patch-notes/';
const PERKS_URL = 'https://owperks.com';
const OUT = 'data/meta.json';
const UA = 'Mozilla/5.0 (compatible; ow-draft-personal/1.0; personal GitHub Pages app, one run per day)';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const nk = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const cap = s => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const log = (...a) => console.log(...a);

async function http(url, { json = false, tries = 4 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html,*/*' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) {
        last = new Error('HTTP ' + r.status + ' for ' + url);
        await sleep(Math.max((+r.headers.get('retry-after') || 0) * 1000, 1500 * (i + 1)));
        continue;
      }
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status + ' for ' + url), { fatal: true });
      return json ? await r.json() : await r.text();
    } catch (e) {
      last = e;
      if (e.fatal) break;
      await sleep(1000 * (i + 1));
    }
  }
  throw last;
}

// ---------- text helpers ----------
function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&rsquo;|&#8217;/g, '’')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
export function toLines(html) {
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<img[^>]*>/gi, ' ');
  t = t.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol|table|header|footer|nav|main|aside|blockquote|dd|dt)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(t).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
export const flat = html => toLines(html).join(' ');
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameAlt = names => [...new Set(names)].sort((a, b) => b.length - a.length).map(reEsc).join('|');
const LABEL = { 'Wins the 1v1': 'duel', 'Team pressure': 'team', 'Mixed threat': 'mixed' };

// ---- Counterwatch: every entry is a link to a hero page, so read the links ----
function heroAnchors(html) {
  const out = [];
  const re = /<a\b[^>]*?href=["']?(?:https?:\/\/[^"'\s>]*)?\/stats\/overwatch\/heroes\/([a-z0-9-]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) out.push({ slug: m[1], text: flat(m[2]) });
  return out;
}
const SIGNED = /(?:^|\s)([+\-−]\d+(?:\.\d+)?)(?![\d.])/;
// Counter page: every hero ranked against the target. Positive = that hero counters the target, negative = target beats it.
export function parseCountersPage(html, selfSlug) {
  const seen = new Set(), out = [];
  for (const a of heroAnchors(html)) {
    if (a.slug === selfSlug || seen.has(a.slug)) continue;
    const m = a.text.match(SIGNED);
    if (!m) continue;
    seen.add(a.slug);
    const l = (a.text.match(/(Wins the 1v1|Team pressure|Mixed threat)/) || [])[1];
    out.push({ slug: a.slug, r: parseFloat(m[1].replace('−', '-')), l: LABEL[l] || null });
  }
  return out;
}
// ---- Perks (owperks.com lists every hero on one page) ----
// "<Hero> View full statistics Minor Perks Community Choice <Name> 72% <text> ... Major Perks Community Choice ..."
export function parsePerks(html, names) {
  let f = flat(html);
  const cut = f.search(/BEST OVERWATCH HERO PERKS OW PERKS|©/);
  if (cut > 0) f = f.slice(0, cut);
  const head = new RegExp('(?<![\\p{L}\\d])(?<n>' + nameAlt(names) + ')(?: New hero)? View full statistics', 'gu');
  const marks = [...f.matchAll(head)].map(m => ({ n: m.groups.n, i: m.index, end: m.index + m[0].length }));
  const one = txt => [...txt.matchAll(/Community Choice (?<name>.+?) (?:(?:New|Updated) )?(?<pct>\d{1,3})% (?<desc>.+?)(?= Community Choice |$)/g)]
    .map(m => ({ n: m.groups.name.trim(), p: +m.groups.pct, d: m.groups.desc.trim().slice(0, 220) }))
    .filter(p => p.n && p.d.length > 8 && p.p <= 100);
  const out = {};
  marks.forEach((mk, k) => {
    let seg = f.slice(mk.end, k + 1 < marks.length ? marks[k + 1].i : f.length).replace(/\s*(?:Tank|Damage|Support) Heroes\s*$/, '');
    const mi = seg.search(/Minor Perks/), ma = seg.search(/Major Perks/);
    if (mi < 0 || ma < 0) return;
    const minor = one(seg.slice(mi, ma)), major = one(seg.slice(ma));
    if (minor.length || major.length) out[mk.n] = { minor, major };
  });
  return out;
}

// Latest official patch notes: first patch on the page, hero section only.
export function parsePatch(html, heroes) {
  const lines = toLines(html);
  const titleRe = /Overwatch Retail Patch Notes/i;
  const ti = lines.findIndex(l => titleRe.test(l));
  if (ti < 0) throw new Error('patch notes title not found');
  const nextTi = lines.findIndex((l, i) => i > ti && titleRe.test(l));
  const stop = nextTi < 0 ? lines.length : nextTi;
  const title = lines[ti];
  const dm = title.match(/([A-Z][a-z]+)\.? (\d{1,2}), (\d{4})/);
  const date = dm ? new Date(`${dm[1]} ${dm[2]}, ${dm[3]} 12:00:00 UTC`).toISOString().slice(0, 10) : null;
  let s = lines.findIndex((l, i) => i > ti && i < stop && /^Hero Updates$/i.test(l));
  if (s < 0) return { title, date, heroes: {} };
  let e = lines.findIndex((l, i) => i > s && i < stop && /^(Stadium Updates|Bug Fixes|Stadium)$/i.test(l));
  if (e < 0) e = stop;
  const byName = new Map(heroes.map(h => [nk(h.name), h]));
  const out = {};
  let cur = null;
  for (let i = s + 1; i < e; i++) {
    const l = lines[i];
    const h = l.length <= 22 ? byName.get(nk(l)) : null;
    if (h) { cur = out[h.key] = { lines: [], dev: '' }; continue; }
    if (/^(Tank|Damage|Support)$/i.test(l) || !cur) continue;
    if (/^Developer Comments:/i.test(l)) cur.dev = l.replace(/^Developer Comments:\s*/i, '').slice(0, 400);
    else if (cur.lines.length < 14) cur.lines.push(l.slice(0, 200));
  }
  Object.keys(out).forEach(k => { if (!out[k].lines.length && !out[k].dev) delete out[k]; });
  return { title, date, heroes: out };
}

// ---------- OpenAPI helpers ----------
function resolveEnum(spec, s) {
  if (!s) return null;
  if (s.$ref) return resolveEnum(spec, spec.components?.schemas?.[s.$ref.split('/').pop()]);
  if (s.enum) return s.enum;
  for (const k of ['anyOf', 'oneOf', 'allOf']) if (s[k]) for (const x of s[k]) { const e = resolveEnum(spec, x); if (e) return e; }
  return null;
}
function findParam(spec, p, re) {
  const params = spec.paths?.[p]?.get?.parameters || [];
  const prm = params.find(x => re.test(x.name));
  return prm ? { name: prm.name, values: resolveEnum(spec, prm.schema) } : null;
}
const asList = j => Array.isArray(j) ? j : (j?.data || j?.heroes || j?.results || []);

// ---------- main ----------
async function readPrev() {
  try { return JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { return null; }
}

export async function main() {
  const prev = await readPrev();
  const meta = { updated: new Date().toISOString(), sources: {} };
  const ok = (k, count, note) => { meta.sources[k] = { ok: true, at: new Date().toISOString(), count, note: note || '' }; log('OK  ', k, count, note || ''); };
  const bad = (k, e) => { meta.sources[k] = { ok: false, at: new Date().toISOString(), error: String(e.message || e).slice(0, 300) }; log('FAIL', k, e.message || e); };

  // 1. OverFast roster (required)
  const [hs, ms, rs] = await Promise.all([http(OF + '/heroes', { json: true }), http(OF + '/maps', { json: true }), http(OF + '/roles', { json: true })]);
  const roster = asList(hs).filter(h => h.key && h.name && h.role).map(h => ({ key: h.key, name: h.name, role: String(h.role).toLowerCase(), portrait: h.portrait || '' }));
  if (roster.length < 20) throw new Error('OverFast returned only ' + roster.length + ' heroes; keeping previous data');
  meta.heroes = roster;
  meta.roles = asList(rs).map(r => ({ key: r.key, name: r.name, description: r.description || '', icon: r.icon || '' }));
  const allMaps = asList(ms);
  ok('roster', roster.length, allMaps.length + ' maps');

  // 2. Official rates by rank and by map (OverFast mirrors Blizzard's hero statistics page)
  try {
    const spec = await http(OF + '/openapi.json', { json: true });
    const P = '/heroes/stats';
    const pPlat = findParam(spec, P, /^platform$/), pMode = findParam(spec, P, /^gamemode$/), pReg = findParam(spec, P, /^region$/),
      pDiv = findParam(spec, P, /division|tier|rank/i), pMap = findParam(spec, P, /^map$/);
    const pick = (prm, want) => (prm && prm.values ? (prm.values.includes(want) ? want : prm.values[0]) : want);
    const base = new URLSearchParams();
    if (pPlat) base.set(pPlat.name, pick(pPlat, 'pc'));
    if (pMode) base.set(pMode.name, pick(pMode, 'competitive'));
    const region = process.env.REGION || 'americas';
    if (pReg) base.set(pReg.name, pick(pReg, region));
    meta.region = pReg ? base.get(pReg.name) : null;
    const divValues = pDiv && pDiv.values ? pDiv.values.map(String) : [];
    const hasAll = divValues.includes('all');
    const divs = hasAll ? divValues : ['all', ...divValues];
    const rates = {}, mapRates = {};
    const fetchRates = async (extra, withBan = true) => {
      const q = new URLSearchParams(base);
      Object.entries(extra).forEach(([k, v]) => v != null && q.set(k, v));
      const j = await http(OF + P + '?' + q, { json: true });
      const o = {};
      asList(j).forEach(x => {
        const k = x.hero || x.key; if (!k) return;
        if (typeof x.winrate === 'number') o[k] = [+x.winrate.toFixed(2), +(x.pickrate ?? 0).toFixed(2)];
        if (withBan) o[k].push(typeof x.banrate === 'number' ? +x.banrate.toFixed(2) : null);
      });
      return o;
    };
    for (const d of divs) {
      try { rates[d] = await fetchRates(d === 'all' && !hasAll ? {} : { [pDiv.name]: d }); } catch (e) { log('  rank', d, 'failed:', e.message); }
      await sleep(400);
    }
    if (!rates.all || !Object.keys(rates.all).length) throw new Error('no all-ranks rates returned');
    meta.divisions = divs.filter(d => rates[d] && Object.keys(rates[d]).length).map(d => ({ key: d, label: d === 'all' ? 'All ranks' : cap(d) }));
    // competitive map list = the map values Blizzard's statistics page supports
    const mapVals = pMap && pMap.values ? pMap.values.map(String).filter(v => !/^all/.test(v)) : [];
    const byNk = new Map(allMaps.map(m => [nk(m.name), m]));
    meta.maps = [];
    const noStats = [];
    for (const v of mapVals) {
      const m = byNk.get(nk(v)) || null;
      const key = nk(m ? m.name : v);
      try {
        const r = await fetchRates({ [pMap.name]: v }, false);
        if (Object.keys(r).length) {
          mapRates[key] = r;
          meta.maps.push({ key, name: m ? m.name : cap(v), modes: m ? m.gamemodes || [] : [], img: m ? m.screenshot || '' : '' });
        } else noStats.push(v);
      } catch (e) { noStats.push(v); }   // HTTP 400 = not in the competitive map pool right now
      await sleep(400);
    }
    log('  maps with competitive stats:', meta.maps.length, '| skipped (not in the competitive pool):', noStats.length);
    meta.knownMaps = allMaps.map(m => nk(m.name));
    meta.rates = rates; meta.mapRates = mapRates;
    ok('rates', Object.keys(rates).length, `${Object.keys(mapRates).length} maps, region ${meta.region || 'default'}`);
  } catch (e) { bad('rates', e); }

  const names = roster.map(h => h.name);
  const byNameNk = new Map(roster.map(h => [nk(h.name), h]));
  const heroBy = new Map(roster.flatMap(h => [[nk(h.key), h], [nk(h.name), h]]));
  const bySlug = slug => heroBy.get(nk(slug));

  // 3. Counterwatch: season and the counter matrix (ratings under 1 point are noise and are left out)
  try {
    const list = await http(CW + '/stats/overwatch/heroes');
    const slugs = [...new Set([...list.matchAll(/\/stats\/overwatch\/heroes\/([a-z0-9-]+)/g)].map(m => m[1]))].filter(x => !/^opengraph/i.test(x));
    if (slugs.length < 15) throw new Error('only found ' + slugs.length + ' hero links on Counterwatch');
    try {
      const tl = flat(await http(CW + '/stats/overwatch/tier-list'));
      const sm = tl.match(/Tier List\W*Season (\d{1,3})/i) || tl.match(/Season (\d{1,3})/);
      if (sm && +sm[1] >= 1 && +sm[1] <= 99) meta.season = { number: +sm[1], source: 'counterwatch.gg' };
    } catch (e) { log('  season lookup failed:', e.message); }
    const counters = {};
    let counterPages = 0, shown = 0;
    for (const slug of slugs) {
      const h = bySlug(slug);
      if (!h) { log('  no roster match for Counterwatch slug', slug); continue; }
      try {
        const html = await http(CW + '/stats/overwatch/counters/' + slug);
        const es = parseCountersPage(html, slug);
        if (es.length) {
          counters[h.key] = {};
          es.forEach(x => { const o = bySlug(x.slug); if (o && o.key !== h.key && Math.abs(x.r) >= 1) counters[h.key][o.key] = [x.r, x.l]; });
          counterPages++;
        } else if (shown++ < 2) log('  DIAG counters page found nothing for', slug, '| links:', heroAnchors(html).length, '| text starts:', flat(html).slice(0, 400));
      } catch (e) { log('  counters page', slug, e.message); }
      await sleep(700);
    }
    if (counterPages < 10) throw new Error(`parsed only ${counterPages} counter pages; page layout may have changed`);
    meta.counters = counters;
    ok('counterwatch', counterPages, `season ${meta.season ? meta.season.number : 'unknown'}`);
  } catch (e) { bad('counterwatch', e); }

  // 4. Blizzard patch notes
  try {
    const p = parsePatch(await http(PATCH_URL), roster);
    const n = Object.keys(p.heroes).length;
    if (!n) throw new Error('no hero changes found in the latest patch notes');
    meta.patch = { date: p.date, heroes: p.heroes };
    ok('patchnotes', n, p.date || '');
  } catch (e) { bad('patchnotes', e); }

  // 5. Perks (community votes)
  try {
    const html = await http(PERKS_URL + '/en');
    const perks = {};
    Object.entries(parsePerks(html, names)).forEach(([n, v]) => { const hero = byNameNk.get(nk(n)); if (hero) perks[hero.key] = v; });
    const n = Object.keys(perks).length;
    if (n < 10) { log('  DIAG perks page text starts:', flat(html).slice(0, 500)); throw new Error('only parsed perks for ' + n + ' heroes'); }
    meta.perks = perks;
    ok('perks', n, 'community vote share');
  } catch (e) { bad('perks', e); }

  // Keep the last good copy of any section whose source failed today
  const keep = (src, fields) => {
    if (meta.sources[src] && meta.sources[src].ok === false && prev) {
      fields.forEach(f => { if (prev[f] !== undefined) meta[f] = prev[f]; });
      meta.sources[src].stale = true;
      meta.sources[src].staleAt = prev.sources && prev.sources[src] ? prev.sources[src].at : prev.updated;
    }
  };
  keep('rates', ['rates', 'mapRates', 'divisions', 'maps', 'knownMaps', 'region']);
  keep('counterwatch', ['counters', 'season']);
  keep('patchnotes', ['patch']);
  keep('perks', ['perks']);
  if (!meta.rates && !meta.divisions) throw new Error('no rates available at all; keeping previous file');

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(meta));
  log('Wrote', OUT, (JSON.stringify(meta).length / 1024).toFixed(0) + ' KB');
  const failed = Object.entries(meta.sources).filter(([, v]) => !v.ok).map(([k]) => k);
  if (failed.length) log('::warning::Some sources failed and were kept from the previous run: ' + failed.join(', '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('::error::' + (e.message || e)); process.exit(1); });
}
