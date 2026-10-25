#!/usr/bin/env node
/*
 * 都市ごとの月別平均気温（日最高・日最低の平均）を作り直して climate.js に書き出す。
 * 年に1回、`node tools/update-climate.mjs` で実行する。
 *
 * 1. 第一候補：その都市の近くの気象観測所の実測（Meteostat の月別データ、直近10年の暦年）
 *    - 都市から50km以内・標高差200m以内の観測所を近い順に試す
 * 2. 観測所が見つからない都市だけ：NASA POWER の格子データ（約50km四方の平均）
 *    - 格子の平均標高と都市の標高の差を、気温の減率 6.5℃/km で補正する
 * 都市の一覧は index.html の CITIES から読むので、都市を足したら実行し直すだけでよい。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(root, 'index.html'), 'utf8');
const m = html.match(/const CITIES=(\[[\s\S]*?\]\]);/);
if (!m) throw new Error('index.html に CITIES が見つかりません');
const CITIES = JSON.parse(m[1]);

const YEARS = 10;
const endY = new Date().getUTCFullYear() - 1;   // 終わった年まで
const startY = endY - YEARS + 1;
const MIN_YEARS = 5;                             // 各月、最低この年数ぶんの実測が要る
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, { gz = false, json = false } = {}) {
  for (let n = 1; n <= 4; n++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (res.ok) {
        if (gz) return gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
        return json ? res.json() : res.text();
      }
      if (res.status !== 429 && res.status < 500) throw new Error('HTTP ' + res.status);
    } catch (e) { if (n === 4) throw e; }
    await sleep(2500 * n);
  }
}
function km(a, b, c, d) {
  const t = Math.PI / 180, h = Math.sin((c - a) * t / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin((d - b) * t / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/* 都市の標高（Open-Meteo の標高API。100地点ずつまとめて） */
const elev = {};
for (let i = 0; i < CITIES.length; i += 100) {
  const part = CITIES.slice(i, i + 100);
  const j = await get(`https://api.open-meteo.com/v1/elevation?latitude=${part.map(c => c[2]).join(',')}&longitude=${part.map(c => c[3]).join(',')}`, { json: true });
  part.forEach((c, k) => elev[c[0]] = j.elevation[k]);
}

/* 観測所の一覧 */
console.log('観測所の一覧を取得中…');
const stations = JSON.parse(await get('https://bulk.meteostat.net/v2/stations/lite.json.gz', { gz: true }))
  .filter(s => s.inventory && s.inventory.monthly && +s.inventory.monthly.end >= 2016);

async function fromStation(name, lat, lon) {
  const near = stations
    .map(s => ({ s, d: km(lat, lon, s.location.latitude, s.location.longitude) }))
    .filter(x => x.d <= 50 && Math.abs((x.s.location.elevation ?? 9999) - elev[name]) <= 200)
    .sort((a, b) => a.d - b.d).slice(0, 4);
  for (const { s, d } of near) {
    const csv = await get(`https://bulk.meteostat.net/v2/monthly/${s.id}.csv.gz`, { gz: true });
    await sleep(300);
    if (!csv) continue;
    const acc = Array.from({ length: 12 }, () => ({ hi: [], lo: [] }));
    for (const line of csv.split('\n')) {
      const f = line.split(',');
      const y = +f[0], mo = +f[1], tmin = f[3], tmax = f[4];
      if (y < startY || y > endY || !mo || tmin === '' || tmax === '' || tmin == null || tmax == null) continue;
      acc[mo - 1].hi.push(+tmax); acc[mo - 1].lo.push(+tmin);
    }
    if (acc.some(a => a.hi.length < MIN_YEARS)) continue;
    const avg = l => l.reduce((x, y) => x + y, 0) / l.length;
    return { v: acc.map(a => [Math.round(avg(a.hi)), Math.round(avg(a.lo))]), src: `観測所 ${s.id}（${Math.round(d)}km）` };
  }
  return null;
}

async function fromGrid(name, lat, lon) {
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN&community=AG` +
    `&latitude=${lat}&longitude=${lon}&start=${startY}0101&end=${endY}1231&format=JSON&time-standard=LST`;
  const j = await get(url, { json: true });
  const p = j.properties.parameter, gridElev = j.geometry.coordinates[2];
  const corr = 0.0065 * ((gridElev ?? elev[name]) - elev[name]);   // 格子が高ければ、都市はその分暖かい
  const acc = Array.from({ length: 12 }, () => ({ hi: 0, lo: 0, n: 0 }));
  for (const [day, hi] of Object.entries(p.T2M_MAX)) {
    const lo = p.T2M_MIN[day];
    if (hi <= -900 || lo == null || lo <= -900) continue;   // 欠測は -999
    const a = acc[+day.slice(4, 6) - 1];
    a.hi += hi; a.lo += lo; a.n++;
  }
  if (acc.some(a => a.n < 200)) throw new Error('日数が足りません');
  return { v: acc.map(a => [Math.round(a.hi / a.n + corr), Math.round(a.lo / a.n + corr)]), src: `格子（標高補正 ${corr >= 0 ? '+' : ''}${corr.toFixed(1)}℃）` };
}

const out = {}, failed = [];
let nSt = 0;
for (const [name, , lat, lon] of CITIES) {
  try {
    let r = await fromStation(name, lat, lon);
    if (r) nSt++; else { r = await fromGrid(name, lat, lon); await sleep(700); }
    out[name] = r.v;
    console.log(`${name}  1月 ${r.v[0].join('/')}  7月 ${r.v[6].join('/')}  ${r.src}`);
  } catch (e) {
    failed.push(name);
    console.log(`${name}  失敗: ${e.message}`);
  }
}

if (failed.length) {
  console.log(`\n取得できなかった都市: ${failed.join('、')}`);
  console.log('climate.js は書き換えていません。時間をおいてもう一度実行してください。');
  process.exit(1);
}
const body = `/* 都市ごとの月別平均気温 [日最高, 日最低]（℃）。${startY}〜${endY}年の平均。
   近くの観測所の実測（Meteostat）を使い、観測所がない都市だけ NASA POWER の格子値を標高で補正。
   更新：node tools/update-climate.mjs（年に1回） */
window.CLIMATE={period:'${startY}-${endY}',data:${JSON.stringify(out)}};
`;
await writeFile(path.join(root, 'climate.js'), body);
console.log(`\nclimate.js を書き出しました（${Object.keys(out).length}都市、うち観測所 ${nSt}・格子 ${Object.keys(out).length - nSt}、${startY}〜${endY}年）`);
