// Overwatch draft data updater.
// Runs inside GitHub Actions (Node 20+, no dependencies) and writes data/meta.json,
// which index.html reads. Every number and sentence the page shows comes from here.
//
// Sources:
//   OverFast API   official Blizzard win/pick/ban rates (by rank and map), roster, maps, roles
//   Counterwatch   hero-vs-hero counter ratings, best duos, tier, comp lean, season number
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
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html,*/*' } });
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
const ROLE = '(?:Tank|Damage|Support)';

function section(text, startRe, endRes) {
  const m = text.search(startRe);
  if (m < 0) return '';
  let end = text.length;
  for (const e of endRes) { const k = text.slice(m + 10).search(e); if (k >= 0) end = Math.min(end, m + 10 + k); }
  return text.slice(m, end);
}

// Counter matchup entries, e.g. "Mauga Mauga Tank Wins the 1v1 +14.1 ≈ +13% High"
export function parseCounterEntries(text, names) {
  const re = new RegExp('(?<![\\p{L}\\d])(?<n>' + nameAlt(names) + ')(?: \\k<n>)? ' + ROLE +
    '(?: (?<l>Wins the 1v1|Team pressure|Mixed threat))? ?(?<r>[+\\-−]\\d+(?:\\.\\d+)?)', 'gu');
  const out = [];
  for (const m of text.matchAll(re)) out.push({ name: m.groups.n, r: parseFloat(m.groups.r.replace('−', '-')), l: LABEL[m.groups.l] || null });
  return out;
}
// Duo entries, e.g. "Torbjörn Torbjörn Damage 58.2% High"
export function parseDuos(text, names) {
  const re = new RegExp('(?<![\\p{L}\\d])(?<n>' + nameAlt(names) + ')(?: \\k<n>)? ' + ROLE + ' (?<w>\\d{2}(?:\\.\\d+)?)%', 'gu');
  return [...text.matchAll(re)].map(m => ({ name: m.groups.n, w: parseFloat(m.groups.w) }));
}
export function parseHeroPage(html, names, self) {
  const f = flat(html);
  const lean = (f.match(/Leans (DIVE|RUSH|POKE)/i) || [])[1];
  const tier = (f.match(/(?:Tank|Damage|Support) Tier ([SABCDF])\b/) || [])[1];
  const sec = section(f, /STRONGEST DUOS/i, [/Heroes to ban against/i, /Performance by Rank/i, /EASIEST MATCHUPS/i, /HARDEST MATCHUPS/i]);
  const seen = new Set(), duos = [];
  parseDuos(sec, names).forEach(d => { if (d.name !== self && !seen.has(d.name)) { seen.add(d.name); duos.push(d); } });
  return { lean: lean ? lean.toLowerCase() : null, tier: tier || null, duos: duos.slice(0, 5) };
}
export function parseCountersPage(html, names, target) {
  const f = flat(html), seen = new Set(), out = [];
  parseCounterEntries(f, names).forEach(e => { if (e.name !== target && !seen.has(e.name)) { seen.add(e.name); out.push(e); } });
  return out;
}

// Perks: pairs of community-vote options; first pair is minor, second pair is major.
function cleanPerkName(n) {
  let w = n.replace(/\b(New|Updated)\b/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  if (w.length % 2 === 0 && w.length > 1 && w.slice(0, w.length / 2).join(' ') === w.slice(w.length / 2).join(' ')) w = w.slice(0, w.length / 2);
  return w.join(' ');
}
export function parsePerks(html, names) {
  const f = flat(html);
  const head = new RegExp('(?<![\\p{L}\\d])(?<n>' + nameAlt(names) + ') (?=Community Choice)', 'gu');
  const marks = [...f.matchAll(head)].map(m => ({ n: m.groups.n, i: m.index, end: m.index + m[0].length }));
  const out = {};
  marks.forEach((mk, k) => {
    const seg = f.slice(mk.end, k + 1 < marks.length ? marks[k + 1].i : f.length);
    const perks = [...seg.matchAll(/Community Choice (?<name>.+?) (?<pct>\d{1,3})% (?<desc>.+?)(?= Community Choice |$)/g)]
      .map(m => ({ n: cleanPerkName(m.groups.name), p: +m.groups.pct, d: m.groups.desc.trim().slice(0, 220) }))
      .filter(p => p.n && p.d.length > 8);
    if (!perks.length) return;
    out[mk.n] = perks.length >= 4 ? { minor: perks.slice(0, 2), major: perks.slice(2, 4) } : { other: perks.slice(0, 4) };
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
  const bad = (k, e) => { meta.sources[k] = { ok: false, at: new Date().toISOString(), error: String(e.message || e).slice(0, 300), stale: !!(prev && prev.sources && prev.sources[k] && prev.sources[k].ok !== undefined) }; log('FAIL', k, e.message || e); };

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
    const fetchRates = async extra => {
      const q = new URLSearchParams(base);
      Object.entries(extra).forEach(([k, v]) => v != null && q.set(k, v));
      const j = await http(OF + P + '?' + q, { json: true });
      const o = {};
      asList(j).forEach(x => {
        const k = x.hero || x.key; if (!k) return;
        if (typeof x.winrate === 'number') o[k] = [+x.winrate.toFixed(2), +(x.pickrate ?? 0).toFixed(2), typeof x.banrate === 'number' ? +x.banrate.toFixed(2) : null];
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
    for (const v of mapVals) {
      const m = byNk.get(nk(v)) || null;
      const key = nk(m ? m.name : v);
      try { mapRates[key] = await fetchRates({ [pMap.name]: v }); } catch (e) { log('  map', v, 'failed:', e.message); }
      meta.maps.push({ key, name: m ? m.name : cap(v), modes: m ? m.gamemodes || [] : [], img: m ? m.screenshot || '' : '' });
      await sleep(400);
    }
    meta.rates = rates; meta.mapRates = mapRates;
    ok('rates', Object.keys(rates).length, `${Object.keys(mapRates).length} maps, region ${meta.region || 'default'}`);
  } catch (e) { bad('rates', e); }

  const names = roster.map(h => h.name);
  const byNameNk = new Map(roster.map(h => [nk(h.name), h]));
  const bySlug = slug => roster.find(h => nk(h.key) === nk(slug) || nk(h.name) === nk(slug));

  // 3. Counterwatch: season, tier, lean, duos, counter matrix
  try {
    const list = await http(CW + '/stats/overwatch/heroes');
    const slugs = [...new Set([...list.matchAll(/\/stats\/overwatch\/heroes\/([a-z0-9-]+)/g)].map(m => m[1]))];
    if (slugs.length < 15) throw new Error('only found ' + slugs.length + ' hero links on Counterwatch');
    try {
      const tl = flat(await http(CW + '/stats/overwatch/tier-list'));
      const sm = tl.match(/Season (\d{1,3})/);
      if (sm && +sm[1] >= 1 && +sm[1] <= 99) meta.season = { number: +sm[1], source: 'counterwatch.gg' };
    } catch (e) { log('  season lookup failed:', e.message); }
    const cw = {}, counters = {};
    let heroPages = 0, counterPages = 0;
    for (const slug of slugs) {
      const h = bySlug(slug);
      if (!h) { log('  no roster match for Counterwatch slug', slug); continue; }
      try {
        const hp = parseHeroPage(await http(CW + '/stats/overwatch/heroes/' + slug), names, h.name);
        cw[h.key] = { tier: hp.tier, lean: hp.lean, duos: hp.duos.map(d => [byNameNk.get(nk(d.name)).key, d.w]) };
        heroPages++;
      } catch (e) { log('  hero page', slug, e.message); }
      await sleep(700);
      try {
        const es = parseCountersPage(await http(CW + '/stats/overwatch/counters/' + slug), names, h.name);
        if (es.length) { counters[h.key] = {}; es.forEach(x => { counters[h.key][byNameNk.get(nk(x.name)).key] = [x.r, x.l]; }); counterPages++; }
      } catch (e) { log('  counters page', slug, e.message); }
      await sleep(700);
    }
    if (heroPages < 10 || counterPages < 10) throw new Error(`parsed too little (${heroPages} hero pages, ${counterPages} counter pages); page layout may have changed`);
    meta.cw = cw; meta.counters = counters;
    ok('counterwatch', counterPages, `${heroPages} hero pages, season ${meta.season ? meta.season.number : 'unknown'}`);
  } catch (e) { bad('counterwatch', e); }

  // 4. Blizzard patch notes
  try {
    const p = parsePatch(await http(PATCH_URL), roster);
    const n = Object.keys(p.heroes).length;
    if (!n) throw new Error('no hero changes found in the latest patch notes');
    meta.patch = { title: p.title, date: p.date, url: PATCH_URL, heroes: p.heroes };
    ok('patchnotes', n, p.date || '');
  } catch (e) { bad('patchnotes', e); }

  // 5. Perks (community votes)
  try {
    const root = await http(PERKS_URL + '/en');
    const pages = [...new Set([...root.matchAll(/href="(\/en\/[a-z-]+)"/g)].map(m => m[1]))].slice(0, 8);
    const htmls = [root];
    for (const pg of pages) { try { htmls.push(await http(PERKS_URL + pg)); } catch (e) { log('  perks page', pg, e.message); } await sleep(600); }
    const perks = {};
    htmls.forEach(h => { const o = parsePerks(h, names); Object.entries(o).forEach(([n, v]) => { const hero = byNameNk.get(nk(n)); if (hero && !perks[hero.key]) perks[hero.key] = v; }); });
    if (Object.keys(perks).length < 10) throw new Error('only parsed perks for ' + Object.keys(perks).length + ' heroes');
    meta.perks = perks;
    ok('perks', Object.keys(perks).length, 'community vote share');
  } catch (e) { bad('perks', e); }

  // Keep the last good copy of any section whose source failed today
  const keep = (src, fields) => {
    if (meta.sources[src] && meta.sources[src].ok === false && prev) {
      fields.forEach(f => { if (prev[f] !== undefined) meta[f] = prev[f]; });
      meta.sources[src].stale = true;
      meta.sources[src].staleAt = prev.sources && prev.sources[src] ? prev.sources[src].at : prev.updated;
    }
  };
  keep('rates', ['rates', 'mapRates', 'divisions', 'maps', 'region']);
  keep('counterwatch', ['cw', 'counters', 'season']);
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
