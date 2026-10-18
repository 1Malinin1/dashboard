// Проверка правила «неполных машин не бывает» (15.10.2026). Код доступа — из env VERIFY_CODE.
// 1) прогон scripts/resupply-report.cjs с выгрузкой строк и плана → сравнение с браузером построчно;
// 2) инварианты в браузере; 3) модульные тесты truckFill на синтетике; 4) UI на трёх площадках + xlsx.
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { chromium } = require(require('path').join(__dirname,'..','node_modules','playwright-core'));
const XLSX = require(require('path').join(__dirname,'..','node_modules','xlsx'));
const V = process.env.OUT_DIR || require('os').tmpdir();
const URL = process.env.URL || 'http://127.0.0.1:8765/index.html';
const CODE = process.env.VERIFY_CODE;
if (!CODE) { console.error('no code'); process.exit(2); }

// ---- 1) скрипт: та же логика, дамп строк и плана
const src = fs.readFileSync(path.join(__dirname,'..','resupply-report.cjs'), 'utf8');
const dumpPath = path.join(V, 'script-ft.json');
const tmp = path.join(__dirname,'..','.ft-dump-tmp.cjs');
fs.writeFileSync(tmp, src + `\nrequire('fs').writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({
  rows: rows.map(r=>({sup:r.sup,shipO:r.shipO,shipW:r.shipW,topUpO:r.topUpO,topUpW:r.topUpW,rollO:r.rollO,rollW:r.rollW,
    oN1:r.oN1,oN2:r.oN2,oM:r.oM,wN1:r.wN1,wN2:r.wN2,wM:r.wM,usedNsk1:r.usedNsk1,usedNsk2:r.usedNsk2,usedMsk:r.usedMsk,rest:r.rest})),
  plan: plan.map(p=>({wh:p.whn,mp:p.mp,total:p.total,full:p.full,trucks:p.trucks.map(t=>({pallets:t.pallets,items:t.items.map(x=>x.sup+'x'+x.pal)})),
    dropped:p.dropped.map(t=>({pallets:t.pallets,items:t.items.map(x=>x.sup+'x'+x.pal)}))}))}));\n`);
try { cp.execFileSync('node', [tmp, '30', '5'], { stdio: 'pipe' }); } finally { fs.unlinkSync(tmp); }
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
    const rows = resupplyRows(), plan = truckPlan(rows);
    const WHF = { 'Евросиб': 'Nsk2', 'Нск-FBS': 'Nsk1', 'Мск': 'Msk' };
    // A — машины ровно 33 паллеты, ≤6 кодов
    let trucks = 0, dropped = 0;
    plan.forEach(p => {
      p.trucks.forEach((t, i) => { trucks++;
        const s = new Set(t.items.map(x => x.sup)), sum = t.items.reduce((a, x) => a + x.pal, 0);
        if (t.pallets !== PALLETS_PER_TRUCK) F('A', p.wh + '|' + p.mp + ' truck ' + i + ' = ' + t.pallets + ' pallets');
        if (s.size > MAX_CODES_PER_TRUCK) F('A', p.wh + '|' + p.mp + ' truck ' + i + ' codes ' + s.size);
        if (s.size !== t.items.length) F('A', 'dup codes in truck');
        if (sum !== t.pallets) F('A', 'sum items != pallets');
        if (t.items.some(x => !(x.pal > 0))) F('A', 'item pal<=0');
      });
      if (p.tailPallets) F('A', p.wh + '|' + p.mp + ' has tail ' + p.tailPallets);
      dropped += (p.dropped || []).length;
      if (p.total !== p.trucks.reduce((a, t) => a + t.pallets, 0)) F('A', 'total mismatch');
    });
    // B — паллеты плана по коду и направлению = поля строк
    const pp = {};
    plan.forEach(p => p.trucks.forEach(t => t.items.forEach(x => { const k = p.wh + '|' + p.mp + '|' + x.sup; pp[k] = (pp[k] || 0) + x.pal; })));
    rows.forEach(r => Object.keys(WHF).forEach(wh => ['ozon', 'wb'].forEach(mp => {
      const k = wh + '|' + mp + '|' + r.sup, rv = r[(mp === 'ozon' ? 'o' : 'w') + WHF[wh]] || 0;
      if (rv !== (pp[k] || 0)) F('B', k + ' row=' + rv + ' plan=' + (pp[k] || 0)); delete pp[k]; })));
    Object.keys(pp).forEach(k => F('B', 'plan code not in rows ' + k));
    // C — склад: взято ≤ можно, штуки = паллеты × вместимость, резерв цел
    rows.forEach(r => {
      if (r.usedNsk2 > r.availNsk2 || r.usedNsk1 > r.availNsk1 || r.usedMsk > r.whMsk) F('C', r.sup + ' used > avail');
      if (r.usedNsk2 < 0 || r.usedNsk1 < 0 || r.usedMsk < 0 || r.shipO < 0 || r.shipW < 0) F('C', r.sup + ' negative');
      if (r.usedNsk1 + r.usedNsk2 + r.usedMsk !== r.shipO + r.shipW + (r.move || 0)) F('C', r.sup + ' used != ship');
      if (r.palOz > 0 && (r.oNsk1 + r.oNsk2 + r.oMsk) * r.palOz !== r.shipO) F('C', r.sup + ' shipO != pal*cap');
      if (r.palWb > 0 && (r.wNsk1 + r.wNsk2 + r.wMsk) * r.palWb !== r.shipW) F('C', r.sup + ' shipW != pal*cap');
      if (r.palOz > 0 && r.palWb > 0) {
        if (r.oNsk2 * r.palOz + r.wNsk2 * r.palWb + (r.move || 0) !== r.usedNsk2) F('C', r.sup + ' usedNsk2 mismatch');
        if (r.oNsk1 * r.palOz + r.wNsk1 * r.palWb !== r.usedNsk1) F('C', r.sup + ' usedNsk1 mismatch');
        if (r.oMsk * r.palOz + r.wMsk * r.palWb !== r.usedMsk) F('C', r.sup + ' usedMsk mismatch');
      }
      const left = r.whNsk2 + r.whNsk1 - r.usedNsk2 - r.usedNsk1;
      if (left < Math.min(RETAIL_RESERVE, r.whNsk2 + r.whNsk1)) F('C', r.sup + ' retail reserve broken');
      if (r.whNsk2 - r.usedNsk2 < Math.min(RETAIL_RESERVE, r.whNsk2)) F('C', r.sup + ' Евросиб reserve broken');
      if (r.whNsk2 < NSK2_MIN_TAKE && r.usedNsk2 > 0) F('C', r.sup + ' took from small Евросиб');
      if (r.shipO + r.shipW > r.haveShip) F('C', r.sup + ' ship > haveShip');
      if (r.topUpO > r.shipO || r.topUpW > r.shipW) F('C', r.sup + ' topUp > ship');
      if (r.topUpO > 0 && !(r.oSpd > 0)) F('C', r.sup + ' Ozon top-up without sales');
      if (r.topUpW > 0 && !(r.wSpd > 0)) F('C', r.sup + ' WB top-up without sales');
    });
    // D — что не едет: rollO/rollW = паллеты отказавших машин × вместимость
    const dr = { ozon: {}, wb: {} };
    plan.forEach(p => (p.dropped || []).forEach(t => t.items.forEach(x => { dr[p.mp][x.sup] = (dr[p.mp][x.sup] || 0) + x.pal; })));
    rows.forEach(r => {
      if ((dr.ozon[r.sup] || 0) * r.palOz !== (r.rollO || 0)) F('D', r.sup + ' rollO ' + r.rollO + ' != dropped ' + (dr.ozon[r.sup] || 0) + 'x' + r.palOz);
      if ((dr.wb[r.sup] || 0) * r.palWb !== (r.rollW || 0)) F('D', r.sup + ' rollW ' + r.rollW + ' != dropped ' + (dr.wb[r.sup] || 0) + 'x' + r.palWb);
    });
    // E — отказавшую машину действительно не добить: на финальном складе свободной ёмкости
    // кодов, продающихся на площадке, меньше, чем недоставало (необходимое условие)
    plan.forEach(p => (p.dropped || []).forEach(t => {
      const need = PALLETS_PER_TRUCK - t.pallets;
      let capAll = 0;
      rows.forEach(r => { const pal = p.mp === 'ozon' ? r.palOz : r.palWb, spd = p.mp === 'ozon' ? r.oSpd : r.wSpd;
        if (!(pal > 0) || !(spd > 0)) return;
        const fr = p.wh === 'Евросиб' ? r.availNsk2 - r.usedNsk2 : (p.wh === 'Нск-FBS' ? r.availNsk1 - r.usedNsk1 : r.whMsk - r.usedMsk);
        capAll += Math.floor(Math.max(0, fr) / pal); });
      // capAll включает и возвращённые паллеты самой машины; добить 33 из неё одной тоже нельзя
      if (capAll >= PALLETS_PER_TRUCK) F('E?', p.wh + '|' + p.mp + ' dropped, but free capacity now ' + capAll + ' pallets (need ' + need + ' + own ' + t.pallets + ')');
    }));
    // детерминизм
    const r2 = resupplyRows();
    const h = rs => rs.reduce((a, r) => a + r.shipO * 7 + r.shipW * 13 + (r.topUpO || 0) * 3 + (r.rollO || 0) * 5 + (r.rollW || 0) * 11, 0);
    if (h(rows) !== h(r2)) F('G', 'not deterministic');
    return { fails, trucks, dropped,
      rows: rows.map(r => ({ sup: r.sup, shipO: r.shipO, shipW: r.shipW, topUpO: r.topUpO, topUpW: r.topUpW, rollO: r.rollO || 0, rollW: r.rollW || 0,
        oN1: r.oNsk1, oN2: r.oNsk2, oM: r.oMsk, wN1: r.wNsk1, wN2: r.wNsk2, wM: r.wMsk, usedNsk1: r.usedNsk1, usedNsk2: r.usedNsk2, usedMsk: r.usedMsk })),
      plan: plan.map(p => ({ wh: p.wh, mp: p.mp === 'ozon' ? 'Ozon' : 'ВБ FBO', total: p.total, full: p.full,
        trucks: p.trucks.map(t => ({ pallets: t.pallets, items: t.items.map(x => x.sup + 'x' + x.pal) })),
        dropped: (p.dropped || []).map(t => ({ pallets: t.pallets, items: t.items.map(x => x.sup + 'x' + x.pal) })) })),
      tot: { shipO: rows.reduce((a, r) => a + r.shipO, 0), shipW: rows.reduce((a, r) => a + r.shipW, 0),
        topUp: rows.reduce((a, r) => a + r.topUpO + r.topUpW, 0), roll: rows.reduce((a, r) => a + (r.rollO || 0) + (r.rollW || 0), 0),
        rest: rows.reduce((a, r) => a + r.rest, 0) } };
  });

  // ---- 3) модульные тесты truckFill на синтетике
  const U = await page.evaluate(() => {
    const res = [];
    const mk = (sup, o) => Object.assign({ sup, palOz: 10, palWb: 10, oSpd: 1, wSpd: 1, oCov: 0, wCov: 0, shipO: 0, shipW: 0 }, o);
    const run = (name, rows, freeMap, t, expect) => {
      const free = {}; rows.forEach(r => free[r.sup] = { 'Мск': freeMap[r.sup] || 0, 'Евросиб': 0, 'Нск-FBS': 0 });
      const out = truckFill(rows, free, { wh: 'Мск', mp: 'ozon' }, t);
      const got = out ? Object.fromEntries([...out].map(([r, p]) => [r.sup, p])) : null;
      let ok = true, why = '';
      if (expect === null) { ok = got === null; why = 'expected null'; }
      else if (got === null) { ok = false; why = 'got null'; }
      else {
        const addPal = Object.values(got).reduce((a, b) => a + b, 0);
        const codes = new Set([...t.items.map(x => x.sup), ...Object.keys(got)]);
        if (addPal !== PALLETS_PER_TRUCK - t.pallets) { ok = false; why += ' added ' + addPal; }
        if (codes.size > MAX_CODES_PER_TRUCK) { ok = false; why += ' codes ' + codes.size; }
        Object.entries(got).forEach(([s, p]) => { if (p * 10 > (freeMap[s] || 0)) { ok = false; why += ' overdraw ' + s; } });
        if (typeof expect === 'function') { const e = expect(got); if (e) { ok = false; why += ' ' + e; } }
      }
      res.push({ name, ok, why, got });
    };
    const T = (pal, sups) => ({ pallets: pal, free: PALLETS_PER_TRUCK - pal, items: sups.map(([s, p]) => ({ sup: s, pal: p })) });
    // 1: обычный добор — горящий код получает паллеты первым
    run('fill-by-days', [mk('A', { oCov: 100 }), mk('B', { oCov: 0 }), mk('C', { oCov: 50 })], { A: 200, B: 200, C: 200 }, T(20, [['A', 20]]),
      g => (g.B || 0) < (g.A || 0) ? 'B (горящий) получил меньше A' : '');
    // 2: 6 кодов в машине, у своих ёмкость 2 паллеты → не добить
    run('slots-full', [1, 2, 3, 4, 5, 6, 7].map(i => mk('S' + i, { oCov: i })), { S1: 10, S2: 10, S7: 1000 },
      T(30, [1, 2, 3, 4, 5, 6].map(i => ['S' + i, 5])), null);
    // 3: последний слот — только тот, кто добьёт
    run('last-slot', [mk('X1', { oCov: 0 }), mk('X2', { oCov: 0 }), mk('BIG', { oCov: 500 }), ...[1, 2, 3, 4, 5].map(i => mk('I' + i, { oCov: 999 }))],
      { X1: 30, X2: 30, BIG: 100 }, T(25, [1, 2, 3, 4, 5].map(i => ['I' + i, 5])), g => g.BIG !== 8 ? 'BIG must take all 8' : '');
    // 4: заглядывание вперёд — мелкие горящие не должны съесть слоты
    run('lookahead', [mk('a', { oCov: 0 }), mk('b', { oCov: 0 }), mk('c', { oCov: 0 }), mk('L', { oCov: 300 }), mk('t1', {}), mk('t2', {}), mk('t3', {})],
      { a: 20, b: 20, c: 20, L: 200 }, T(20, [['t1', 10], ['t2', 5], ['t3', 5]]), g => !g.L ? 'L missing' : '');
    // 5: без продаж — не кандидат
    run('no-sales', [mk('N', { oSpd: 0 }), mk('t', {})], { N: 1000 }, T(20, [['t', 20]]), null);
    // 6: свободного мало — не добить
    run('short', [mk('p', {}), mk('t', {})], { p: 50 }, T(20, [['t', 20]]), null);
    return res;
  });

  // ---- 4) UI: вид подсорта на трёх площадках, KPI-подсказка, план, xlsx
  const UI = {};
  await page.evaluate(() => switchTab('turnover')); await page.waitForTimeout(800);
  const bv = await page.$('#turnViewSeg button[data-view="resupply"]'); if (bv) { await bv.click(); await page.waitForTimeout(1200); }
  for (const mp of ['ozon', 'wb', 'all']) {
    const b = await page.$('#mpSwitch button[data-mp="' + mp + '"]');
    if (b && await b.isVisible()) { await b.click(); await page.waitForTimeout(1500); }
    UI[mp] = await page.evaluate(() => ({
      trucks: (document.getElementById('turnTrucks') || {}).innerText || '',
      kpi: [...document.querySelectorAll('#turnKpis .kpi')].map(e => e.innerText.replace(/\s+/g, ' ')),
      tipHasRoll: [...document.querySelectorAll('#turnKpis [data-tip]')].some(k=>decodeURIComponent(k.getAttribute('data-tip')).includes('машину не собрать')),
      cellsRoll: [...document.querySelectorAll('#turnTable .sub2.crit')].map(e => e.innerText).filter(t => /не едет/.test(t)).length,
      cellsTop: [...document.querySelectorAll('#turnTable .sub2.acc')].map(e => e.innerText).filter(t => /добор машины/.test(t)).length,
      howto: (document.getElementById('turnHowTo') || {}).innerText || ''
    }));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => exportResupplyXLSX())]);
    const fp = path.join(V, 'dl', 'ft-' + mp + '.xlsx'); fs.mkdirSync(path.dirname(fp), { recursive: true }); await dl.saveAs(fp);
    const wb = XLSX.readFile(fp);
    const tr = XLSX.utils.sheet_to_json(wb.Sheets['Машины'], { header: 1, defval: '' });
    const pod = XLSX.utils.sheet_to_json(wb.Sheets['Подсорт'], { header: 1, defval: '' });
    UI[mp].xlsx = { sheets: wb.SheetNames, notGoingRows: tr.filter(r => String(r[2]).startsWith('НЕ ЕДЕТ')).length,
      head: (pod[0] || []).filter(h => /НЕ ЕДЕТ|добор/.test(h)) };
  }
  await browser.close();

  // ---- сравнение браузер ↔ скрипт
  const cmp = [];
  const sb = new Map(S.rows.map(r => [r.sup, r]));
  B.rows.forEach(r => { const s = sb.get(r.sup); if (!s) { if (r.shipO || r.shipW || r.rollO || r.rollW) cmp.push('row only in browser ' + r.sup); return; }
    ['shipO', 'shipW', 'topUpO', 'topUpW', 'rollO', 'rollW', 'oN1', 'oN2', 'oM', 'wN1', 'wN2', 'wM', 'usedNsk1', 'usedNsk2', 'usedMsk']
      .forEach(k => { if ((r[k] || 0) !== (s[k] || 0)) cmp.push(r.sup + ' ' + k + ' browser=' + r[k] + ' script=' + s[k]); }); });
  const planKey = pl => JSON.stringify(pl.map(p => [p.wh, p.mp, p.total, p.full, p.trucks, p.dropped]).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])));
  if (planKey(B.plan) !== planKey(S.plan)) cmp.push('PLAN differs');

  const out = { errors, fails: B.fails, trucks: B.trucks, droppedTrucks: B.dropped, tot: B.tot, cmp, unit: U, UI };
  fs.writeFileSync(path.join(V, 'fulltruck-result.json'), JSON.stringify(out, null, 1));
  console.log('console errors:', errors.length, errors.slice(0, 3));
  console.log('invariant fails:', B.fails.length, B.fails.slice(0, 10));
  console.log('browser≠script:', cmp.length, cmp.slice(0, 10));
  console.log('trucks:', B.trucks, 'dropped:', B.dropped, 'totals:', JSON.stringify(B.tot));
  console.log('unit:', U.map(u => u.name + ':' + (u.ok ? 'ok' : 'FAIL ' + u.why)).join(' | '));
  Object.entries(UI).forEach(([mp, u]) => console.log('UI', mp, '| roll cells', u.cellsRoll, '| topup cells', u.cellsTop, '| tipRoll', u.tipHasRoll,
    '| plan "Не едет"', /Не едет/.test(u.trucks), '| xlsx', JSON.stringify(u.xlsx)));
})().catch(e => { console.error('FAILED', e && e.stack || e); process.exit(1); });
