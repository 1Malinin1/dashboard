// Проверка подсорта по правилам с 27.10.2026 (ЗАП-08, ЗАП-11, ЗАП-13). Код доступа — из env VERIFY_CODE.
// 1) прогон scripts/resupply-report.cjs с выгрузкой строк и плана → сравнение с браузером по каждому
//    коду, направлению и складу; 2) инварианты в браузере; 3) модульные тесты truckFill на синтетике;
//    4) UI на трёх площадках + xlsx.
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { chromium } = require(path.join(__dirname,'..','node_modules','playwright-core'));
const XLSX = require(path.join(__dirname,'..','node_modules','xlsx'));
const V = process.env.OUT_DIR || require('os').tmpdir();
const URL = process.env.URL || 'http://127.0.0.1:8765/index.html';
const CODE = process.env.VERIFY_CODE;
if (!CODE) { console.error('no code'); process.exit(2); }

// ---- 1) скрипт: та же логика, дамп строк и плана
const src = fs.readFileSync(path.join(__dirname,'..','resupply-report.cjs'), 'utf8');
const dumpPath = path.join(V, 'script-ft.json');
const tmp = path.join(__dirname,'..','.ft-dump-tmp.cjs');
fs.writeFileSync(tmp, src + `\nrequire('fs').writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({
  rows: rows.map(r=>({sup:r.sup, d:Object.fromEntries(DIRS.map(d=>[d.key,{need:r.D[d.key].need,ship:r.D[d.key].ship,
    top:r.D[d.key].topUp,roll:r.D[d.key].roll,pal:r.D[d.key].pal,pcs:r.D[d.key].pcs}])), hold:r.hold, rest:r.rest})),
  plan: plan.map(p=>({wh:p.wh,k:p.k,total:p.total,trucks:p.trucks.map(t=>t.items.map(x=>x.sup+'x'+x.pal).join(',')),
    dropped:p.dropped.map(t=>t.items.map(x=>x.sup+'x'+x.pal).join(','))}))}));\n`);
try { cp.execFileSync('node', [tmp, '-', '5'], { stdio: 'pipe' }); } finally { fs.unlinkSync(tmp); }
const S = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#lockInput', { timeout: 30000 });
  await page.fill('#lockInput', CODE);
  await page.click('.lock-btn');
  await page.waitForFunction(() => typeof resupplyRows === 'function' && typeof RD !== 'undefined' && RD && RD.warehouse && typeof WBDATA !== 'undefined' && WBDATA, null, { timeout: 90000 });
  await page.waitForTimeout(2500);

  const B = await page.evaluate(() => {
    const fails = [], F = (k, m) => fails.push(k + ': ' + m);
    const rows = resupplyRows(), plan = truckPlan(rows), bySup = {}; rows.forEach(r => bySup[r.sup] = r);
    const capOf = (r, k) => k === 'wFbo' ? r.palWb : r.palOz;
    // A — машины ровно 33 паллеты, ≤ 6 кодов, неполных нет
    let trucks = 0, dropped = 0;
    plan.forEach(p => {
      p.trucks.forEach((t, i) => { trucks++;
        const s = new Set(t.items.map(x => x.sup)), sum = t.items.reduce((a, x) => a + x.pal, 0);
        if (t.pallets !== PALLETS_PER_TRUCK || sum !== t.pallets) F('A', p.wh + '→' + p.dir + ' машина ' + i + ' = ' + t.pallets + '/' + sum + ' палл');
        if (s.size > MAX_CODES_PER_TRUCK || s.size !== t.items.length) F('A', p.wh + '→' + p.dir + ' машина ' + i + ' кодов ' + s.size);
        if (t.items.some(x => !(x.pal > 0))) F('A', 'паллет ≤ 0 в машине');
        // E — добор только при базе ≥ 20
        if (t.base != null && t.base < t.pallets && t.base < TOPUP_MIN_BASE) F('E', p.wh + '→' + p.dir + ' добита при базе ' + t.base);
      });
      if (p.tailPallets) F('A', p.wh + '→' + p.dir + ' остаток ' + p.tailPallets);
      dropped += (p.dropped || []).length;
    });
    // B — паллеты плана по коду, складу и направлению = поля строк
    const pp = {};
    plan.forEach(p => p.trucks.forEach(t => t.items.forEach(x => { const k = p.whKey + '|' + p.dir + '|' + x.sup; pp[k] = (pp[k] || 0) + x.pal; })));
    rows.forEach(r => RESUP_WH.forEach(w => RESUP_DIRS.forEach(d => {
      const k = w + '|' + d.key + '|' + r.sup, rv = r.D[d.key].pal[w] || 0;
      if (rv !== (pp[k] || 0)) F('B', k + ' строка=' + rv + ' план=' + (pp[k] || 0)); delete pp[k]; })));
    Object.keys(pp).forEach(k => F('B', 'код плана не в строках ' + k));
    // C — склад: взято ≤ можно, штуки = паллеты × вместимость + штучно
    rows.forEach(r => {
      const can = { klin: r.whKlin, nsk2: r.availNsk2, nsk1: r.availNsk1, msk: r.whMsk };
      RESUP_WH.forEach(w => { const used = RESUP_DIRS.reduce((a, d) => a + r.D[d.key].pal[w] * capOf(r, d.key) + r.D[d.key].pcs[w], 0);
        if (used > can[w]) F('C', r.sup + ' ' + w + ' взято ' + used + ' > ' + can[w]); });
      RESUP_DIRS.forEach(d => { const x = r.D[d.key];
        const s = RESUP_WH.reduce((a, w) => a + x.pal[w] * capOf(r, d.key) + x.pcs[w], 0);
        if (s !== x.ship) F('C', r.sup + ' ' + d.key + ' ship ' + x.ship + ' ≠ паллеты×вместимость ' + s);
        if (x.topUp > x.ship) F('C', r.sup + ' ' + d.key + ' добор > отгрузки');
        if (x.topUp > 0 && !(x.spd > 0)) F('C', r.sup + ' ' + d.key + ' добор без продаж');
        // E — добор только товаром до TOPUP_MAX_DAYS
        if (x.topUp > 0 && (x.cov + x.ship) / x.spd > TOPUP_MAX_DAYS + 1e-9) F('E', r.sup + ' ' + d.key + ' добран до ' + Math.round((x.cov + x.ship) / x.spd) + ' дн');
      });
      if (r.whNsk2 < NSK2_MIN_TAKE && r.usedNsk2 > 0) F('C', r.sup + ' взят мелкий Евросиб');
      if (r.shipO + r.shipW > r.haveShip) F('C', r.sup + ' отгрузка > склада');
      if (r.shipO !== r.D.oMsk.ship + r.D.oKzn.ship || r.shipW !== r.D.wFbo.ship) F('C', r.sup + ' сводные поля не сходятся');
    });
    // D — «не едет» = паллеты отказавших машин × вместимость (по направлению)
    const dr = {};
    plan.forEach(p => (p.dropped || []).forEach(t => t.items.forEach(x => { const k = p.dir + '|' + x.sup; dr[k] = (dr[k] || 0) + x.pal; })));
    rows.forEach(r => RESUP_DIRS.forEach(d => { const k = d.key + '|' + r.sup;
      if ((dr[k] || 0) * capOf(r, d.key) !== (r.D[d.key].roll || 0)) F('D', k + ' roll ' + r.D[d.key].roll + ' ≠ не едет ' + (dr[k] || 0) + '×' + capOf(r, d.key)); }));
    // G — детерминизм
    const r2 = resupplyRows();
    const h = rs => rs.reduce((a, r) => a + r.shipO * 7 + r.shipW * 13 + (r.topUpO || 0) * 3 + (r.rollO || 0) * 5 + (r.rollW || 0) * 11 + r.D.oKzn.ship * 17, 0);
    if (h(rows) !== h(r2)) F('G', 'расчёт не детерминирован');
    return { fails, trucks, dropped,
      rows: rows.map(r => ({ sup: r.sup, d: Object.fromEntries(RESUP_DIRS.map(d => [d.key, { need: r.D[d.key].need, ship: r.D[d.key].ship,
        top: r.D[d.key].topUp, roll: r.D[d.key].roll, pal: r.D[d.key].pal, pcs: r.D[d.key].pcs }])), hold: r.hold, rest: r.rest })),
      plan: plan.map(p => ({ wh: p.whKey, k: p.dir, total: p.total, trucks: p.trucks.map(t => t.items.map(x => x.sup + 'x' + x.pal).join(',')),
        dropped: (p.dropped || []).map(t => t.items.map(x => x.sup + 'x' + x.pal).join(',')) })),
      tot: Object.fromEntries(RESUP_DIRS.map(d => [d.key, rows.reduce((a, r) => a + r.D[d.key].ship, 0)])) };
  });

  // ---- 3) модульные тесты truckFill на синтетике (склад «msk», направление oMsk, паллета 10 шт)
  const U = await page.evaluate(() => {
    const res = [];
    const mk = (sup, o) => { o = Object.assign({ spd: 1, cov: 0, ship: 0, pool: 0 }, o);
      return { sup, palOz: 10, palWb: 10, pool: { klin: 0, nsk2: 0, nsk1: 0, msk: o.pool },
        D: { oMsk: { spd: o.spd, cov: o.cov, ship: o.ship, days: o.spd > 0 ? o.cov / o.spd : 0 } } }; };
    const run = (name, rows, t, expect) => {
      const out = truckFill(rows, { wh: 'msk', k: 'oMsk' }, t);
      const got = out ? Object.fromEntries([...out].map(([r, p]) => [r.sup, p])) : null;
      let ok = true, why = '';
      if (expect === null) { ok = got === null; why = 'ожидали null'; }
      else if (got === null) { ok = false; why = 'получили null'; }
      else {
        const addPal = Object.values(got).reduce((a, b) => a + b, 0);
        const codes = new Set([...t.items.map(x => x.sup), ...Object.keys(got)]);
        if (addPal !== PALLETS_PER_TRUCK - t.pallets) { ok = false; why += ' добавлено ' + addPal; }
        if (codes.size > MAX_CODES_PER_TRUCK) { ok = false; why += ' кодов ' + codes.size; }
        rows.forEach(r => { const p = got[r.sup] || 0;
          if (p * 10 > r.pool.msk) { ok = false; why += ' перебор склада ' + r.sup; }
          if (p && (r.D.oMsk.cov + r.D.oMsk.ship + p * 10) / r.D.oMsk.spd > TOPUP_MAX_DAYS) { ok = false; why += ' выше ' + TOPUP_MAX_DAYS + ' дн ' + r.sup; } });
        if (typeof expect === 'function') { const e = expect(got); if (e) { ok = false; why += ' ' + e; } }
      }
      res.push({ name, ok, why, got });
    };
    const T = (pal, sups) => ({ pallets: pal, free: PALLETS_PER_TRUCK - pal, items: sups.map(([s, p]) => ({ sup: s, pal: p })) });
    // 1: горящий код получает паллеты первым (спрос 2/дн — 8 мес = 480 шт, ёмкость по сроку не мешает)
    run('по-дням', [mk('A', { spd: 2, cov: 100, pool: 200 }), mk('B', { spd: 2, cov: 0, pool: 200 }), mk('C', { spd: 2, cov: 50, pool: 200 })], T(20, [['A', 20]]),
      g => (g.B || 0) < (g.A || 0) ? 'B (горящий) получил меньше A' : '');
    // 2: потолок 8 месяцев — код с запасом под потолок не берёт больше, чем влезает до 240 дн
    run('потолок-240', [mk('P', { spd: 1, cov: 200, pool: 1000 }), mk('Q', { spd: 5, cov: 0, pool: 1000 })], T(20, [['Q', 20]]),
      g => (g.P || 0) > 4 ? 'P взял ' + g.P + ' палл при запасе 200 дн' : '');
    // 3: всё уже выше 8 месяцев — добить нечем
    run('всё-выше-240', [mk('H', { spd: 1, cov: 300, pool: 1000 }), mk('t', {})], T(20, [['t', 20]]), null);
    // 4: 6 кодов в машине, у своих ёмкость мала → не добить
    run('слоты-заняты', [1, 2, 3, 4, 5, 6, 7].map(i => mk('S' + i, { spd: 5, cov: i, pool: i <= 2 ? 10 : (i === 7 ? 1000 : 0) })),
      T(30, [1, 2, 3, 4, 5, 6].map(i => ['S' + i, 5])), null);
    // 5: без продаж — не кандидат
    run('без-продаж', [mk('N', { spd: 0, pool: 1000 }), mk('t', {})], T(20, [['t', 20]]), null);
    // 6: свободного мало — не добить
    run('мало-товара', [mk('p', { spd: 5, pool: 50 }), mk('t', {})], T(20, [['t', 20]]), null);
    return res;
  });

  // ---- 4) UI: вид подсорта на трёх площадках, план, xlsx
  const UI = {};
  await page.evaluate(() => switchTab('turnover')); await page.waitForTimeout(800);
  const bv = await page.$('#turnViewSeg button[data-view="resupply"]'); if (bv) { await bv.click(); await page.waitForTimeout(1200); }
  for (const mp of ['ozon', 'wb', 'all']) {
    const b = await page.$('#mpSwitch button[data-mp="' + mp + '"]');
    if (b && await b.isVisible()) { await b.click(); await page.waitForTimeout(1500); }
    UI[mp] = await page.evaluate(() => ({
      trucks: (document.getElementById('turnTrucks') || {}).innerText || '',
      kpi: [...document.querySelectorAll('#turnKpis .kpi')].map(e => e.innerText.replace(/\s+/g, ' ')),
      howto: (document.getElementById('turnHowTo') || {}).textContent || ''
    }));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => exportResupplyXLSX())]);
    const fp = path.join(V, 'dl', 'ft-' + mp + '.xlsx'); fs.mkdirSync(path.dirname(fp), { recursive: true }); await dl.saveAs(fp);
    const wb = XLSX.readFile(fp);
    const tr = XLSX.utils.sheet_to_json(wb.Sheets['Машины'], { header: 1, defval: '' });
    UI[mp].xlsx = { sheets: wb.SheetNames, notGoingRows: tr.filter(r => String(r[2]).startsWith('НЕ ЕДЕТ')).length,
      trucksRows: tr.filter(r => /^Машина \d+$|^Машина \d+ \(/.test(String(r[2]))).length };
  }
  await browser.close();

  // ---- сравнение браузер ↔ скрипт
  const cmp = [];
  const sb = new Map(S.rows.map(r => [r.sup, r]));
  B.rows.forEach(r => { const s = sb.get(r.sup);
    if (!s) { if (Object.values(r.d).some(x => x.ship || x.roll)) cmp.push('строка только в браузере ' + r.sup); return; }
    if (JSON.stringify(r.d) !== JSON.stringify(s.d)) cmp.push(r.sup + ' браузер=' + JSON.stringify(r.d) + ' скрипт=' + JSON.stringify(s.d));
    if (JSON.stringify(r.hold) !== JSON.stringify(s.hold)) cmp.push(r.sup + ' hold различается'); });
  const planKey = pl => JSON.stringify(pl.map(p => [p.wh, p.k, p.total, p.trucks.slice().sort(), p.dropped.slice().sort()])
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])));
  if (planKey(B.plan) !== planKey(S.plan)) cmp.push('ПЛАН МАШИН различается');

  const out = { errors, fails: B.fails, trucks: B.trucks, droppedTrucks: B.dropped, tot: B.tot, cmp, unit: U, UI };
  fs.writeFileSync(path.join(V, 'fulltruck-result.json'), JSON.stringify(out, null, 1));
  console.log('console errors:', errors.length, errors.slice(0, 3));
  console.log('invariant fails:', B.fails.length, B.fails.slice(0, 10));
  console.log('browser≠script:', cmp.length, cmp.slice(0, 5));
  console.log('trucks:', B.trucks, 'dropped:', B.dropped, 'отгрузка по направлениям:', JSON.stringify(B.tot));
  console.log('unit:', U.map(u => u.name + ':' + (u.ok ? 'ok' : 'FAIL ' + u.why)).join(' | '));
  Object.entries(UI).forEach(([mp, u]) => console.log('UI', mp, '| план «Не едет»', /Не едет/.test(u.trucks),
    '| план «Казань»', /Казань/.test(u.trucks), '| справка про 20 паллет', /20 паллет/.test(u.howto), '| xlsx', JSON.stringify(u.xlsx)));
})().catch(e => { console.error('FAILED', e && e.stack || e); process.exit(1); });
