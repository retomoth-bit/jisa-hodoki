#!/usr/bin/env node
/*
 * 都市ごとの月別平均気温（日最高・日最低の平均）を作り直して climate.js に書き出す。
 * 年に1回、`node tools/update-climate.mjs` で実行する。
 * データ：NASA POWER（日別の T2M_MAX / T2M_MIN、直近10年の暦年）。キー不要・無料。
 * 都市の一覧は index.html の CITIES から読むので、都市を足したら実行し直すだけでよい。
 */
import { readFile, writeFile } from 'node:fs/promises';
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
const out = {};
const failed = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCity(lat, lon) {
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN&community=AG` +
    `&latitude=${lat}&longitude=${lon}&start=${startY}0101&end=${endY}1231&format=JSON&time-standard=LST`;
  for (let tryN = 1; tryN <= 4; tryN++) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()).properties.parameter;
      if (res.status !== 429 && res.status < 500) throw new Error('HTTP ' + res.status);
    } catch (e) { if (tryN === 4) throw e; }
    await sleep(3000 * tryN);
  }
}

for (const [name, , lat, lon] of CITIES) {
  try {
    const p = await fetchCity(lat, lon);
    const acc = Array.from({ length: 12 }, () => ({ hi: 0, lo: 0, n: 0 }));
    for (const [day, hi] of Object.entries(p.T2M_MAX)) {
      const lo = p.T2M_MIN[day];
      if (hi <= -900 || lo == null || lo <= -900) continue;   // 欠測は -999
      const a = acc[+day.slice(4, 6) - 1];
      a.hi += hi; a.lo += lo; a.n++;
    }
    if (acc.some(a => a.n < 200)) throw new Error('日数が足りません');
    out[name] = acc.map(a => [Math.round(a.hi / a.n), Math.round(a.lo / a.n)]);
    console.log(`${name}  1月 ${out[name][0].join('/')}  7月 ${out[name][6].join('/')}`);
  } catch (e) {
    failed.push(name);
    console.log(`${name}  失敗: ${e.message}`);
  }
  await sleep(700);
}

if (failed.length) {
  console.log(`\n取得できなかった都市: ${failed.join('、')}`);
  console.log('climate.js は書き換えていません。時間をおいてもう一度実行してください。');
  process.exit(1);
}
const body = `/* 都市ごとの月別平均気温 [日最高, 日最低]（℃）。${startY}〜${endY}年の平均。NASA POWER の日別値から作成。
   更新：node tools/update-climate.mjs（年に1回） */
window.CLIMATE={period:'${startY}-${endY}',data:${JSON.stringify(out)}};
`;
await writeFile(path.join(root, 'climate.js'), body);
console.log(`\nclimate.js を書き出しました（${Object.keys(out).length}都市、${startY}〜${endY}年）`);
