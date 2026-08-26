// Готовит файл «паллеты-заполнить.xlsx» — товары, по которым НЕ ЗАДАНА вместимость паллеты.
// Отгрузка со склада на площадку считается только целыми паллетами, поэтому без этой цифры
// товар не попадает в план машин: везётся штучно либо не планируется вовсе.
//
// Товары со статусом «На вывод» в файл НЕ включаются (просьба продавца 26.08: «пометь их,
// чтобы больше не скидывать») — статус ставится scripts/set-prod-status.cjs. Флаг --all
// возвращает их в файл, если нужна полная картина.
//
// Строки отсортированы по важности: сверху то, что нужно везти прямо сейчас и лежит на складе.
// Продавец заполняет две последние колонки и присылает файл обратно → update-pallets.cjs.
//
// Требует запущенного локального сервера дашборда (данные подсорта берутся из него,
// чтобы цифры совпадали один в один):  http-server . -p 8123
//
// Использование: node scripts/missing-pallets-report.cjs [--all]
const {chromium}=require('/opt/node22/lib/node_modules/playwright');
const XLSX=require('./node_modules/xlsx');
const fs=require('fs'),vm=require('vm');
const path=require('path');
const DEC=path.join(__dirname,'..','decrypted');
const OUT=path.join(DEC,'паллеты-заполнить.xlsx');
(async()=>{
  const c={};vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(DEC,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',c);
  const RD=c.__RD;
  const P=(RD.pallets&&RD.pallets.bySup)||{};
  const wh=(RD.warehouse&&RD.warehouse.bySup)||{};
  const ozSet=new Set((RD.ozon&&RD.ozon.catalog||[]).map(x=>''+x.sku));

  // данные подсорта и продаж — из дашборда, чтобы совпадало один в один
  const br=await chromium.launch(); const p=await br.newPage();
  await p.goto('http://127.0.0.1:8123/index.html',{waitUntil:'networkidle'});
  await p.fill('#lockInput','kalinin2605'); await p.click('.lock-btn');
  await p.waitForFunction(()=>typeof FINANCE_CACHE!=='undefined'&&FINANCE_CACHE.length>0,{timeout:60000});
  await p.waitForTimeout(1500);
  const R=await p.evaluate(()=>{
    switchTab('turnover'); turnView='resupply'; renderTurnoverTab();
    const res={}; resupplyRows().forEach(r=>{ res[r.sup]={need:(r.needW||0)+(r.needO||0),
      ship:(r.shipW||0)+(r.shipO||0), note:r.palNote||''}; });
    switchTab('stockrate'); renderStockRateTab();
    const sr={}; srDecorate(srRows()).forEach(r=>{ sr[r.sup]={spd:r.spd,total:r.total,
      wb:r.stockWb,oz:r.stockOz,wh:r.whQty,name:r.name,cat:r.category,sku:r.wbSku}; });
    return {res,sr};
  });
  await br.close();

  // все коды 1С каталога ВБ + те, что есть на складе
  const sups=new Set();
  RD.catalog.forEach(x=>{const s=(''+(x.supplierCode||'')).trim(); if(s) sups.add(s);});
  Object.keys(wh).forEach(s=>sups.add(s));
  const nm={},cat={},sku={};
  RD.catalog.forEach(x=>{const s=(''+(x.supplierCode||'')).trim(); if(!s) return;
    if(!nm[s]) {nm[s]=x.name; cat[s]=x.category; sku[s]=''+x.sku;} });

  // «На вывод» в файл НЕ попадают: просить вместимость паллеты у выводимого товара незачем
  //   (просьба продавца 26.08 — «пометь их, чтобы больше не скидывать»).
  //   Флаг --all возвращает их обратно, если понадобится полная картина.
  const withOut=process.argv.includes('--all');
  const outSup=new Set(); {
    const st={}; RD.catalog.forEach(c=>{ const s=(''+(c.supplierCode||'')).trim(); if(!s) return;
      const o=(''+(c.productionStatus||'')).trim()==='На вывод';
      st[s]=(st[s]===undefined)? o : (st[s]&&o); });
    Object.keys(st).forEach(s=>{ if(st[s]) outSup.add(s); });
  }
  let skippedOut=0;
  const rows=[];
  sups.forEach(s=>{
    if(!withOut && outSup.has(s)){ skippedOut++; return; }
    const v=P[s];
    const hasWb=v&&v.wb>0, hasOz=v&&v.oz>0;
    if(hasWb&&hasOz) return;                       // вместимость есть для обеих площадок
    const w=wh[s]||{qty:0,wh:{}};
    let nsk=0,msk=0; Object.entries(w.wh||{}).forEach(([n,q])=>{
      if(/евросиб/i.test(n)) nsk+=q; else if(/солнечногор/i.test(n)) msk+=q; });
    const S=R.sr[s]||{}, RE=R.res[s]||{};
    // насколько это мешает прямо сейчас
    const why = (RE.need>0 && (w.qty||0)>0) ? 'СРОЧНО: нужно везти, но паллета неизвестна'
      : (RE.need>0) ? 'нужно везти, но на складе пусто'
      : ((w.qty||0)>0) ? 'лежит на складе — понадобится при отгрузке'
      : ((S.spd||0)>0) ? 'продаётся, склад пуст'
      : 'нет остатка и продаж';
    const rank = (RE.need>0 && (w.qty||0)>0) ? 0 : (RE.need>0? 1 : ((w.qty||0)>0? 2 : ((S.spd||0)>0? 3 : 4)));
    rows.push({s, why, rank, name:S.name||nm[s]||'', cat:S.cat||cat[s]||'', sku:S.sku||sku[s]||'',
      onOz:ozSet.has(s)?'да':'нет',
      whAll:w.qty||0, nsk, msk, stockWb:S.wb||0, stockOz:S.oz||0,
      spd:S.spd||0, need:RE.need||0, ship:RE.ship||0,
      palWb:hasWb? v.wb : '', palOz:hasOz? v.oz : ''});
  });
  // сначала то, что реально мешает: есть на складе и нужно везти
  rows.sort((a,b)=> (a.rank-b.rank) || (b.need-a.need) || (b.whAll-a.whAll) || (b.spd-a.spd));

  const head=["Важность","Код 1С","Артикул ВБ","Наименование","Категория","Есть на Ozon",
    "Свой склад всего, шт","Склад Нск, шт","Склад Мск, шт","Остаток ВБ, шт","Остаток Ozon, шт",
    "Продаж/дн (обе площадки)","Нужно подсортить, шт","Отгружаем сейчас, шт",
    "ПАЛЛЕТА ВБ, шт (заполнить)","ПАЛЛЕТА OZON, шт (заполнить)"];
  const data=[head];
  rows.forEach(r=>data.push([r.why,r.s,r.sku,r.name,r.cat,r.onOz,r.whAll,r.nsk,r.msk,
    r.stockWb,r.stockOz,+r.spd.toFixed(2),r.need,r.ship,r.palWb,r.palOz]));
  const sh=XLSX.utils.aoa_to_sheet(data);
  sh['!cols']=[{wch:40},{wch:10},{wch:13},{wch:46},{wch:20},{wch:13},{wch:20},{wch:15},{wch:15},
    {wch:15},{wch:17},{wch:24},{wch:21},{wch:21},{wch:26},{wch:28}];
  const wbk=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbk,sh,'Заполнить паллеты');
  const info=XLSX.utils.aoa_to_sheet([
    ["Зачем этот файл",""],
    ["","Отгрузка со склада на площадку считается ТОЛЬКО целыми паллетами."],
    ["","Если вместимость паллеты неизвестна, товар в план машин не попадает —"],
    ["","он либо везётся штучно, либо не планируется вовсе."],
    ["",""],
    ["Что заполнить",""],
    ["","Две последние колонки: сколько штук этого товара влезает на паллету"],
    ["","отдельно для ВБ и для Ozon (у площадок вместимость разная)."],
    ["","Если значение уже стоит — оно известно, менять не нужно."],
    ["",""],
    ["Сортировка","по колонке «Важность»: сверху то, что мешает прямо сейчас"],
    ["Важность","«СРОЧНО» — товар надо везти и он есть на складе, но паллета неизвестна;"],
    ["","ниже — то, что понадобится позже; в конце — товары без остатка и продаж"],
    ["Вместимость известна для",Object.keys((RD.pallets&&RD.pallets.bySup)||{}).length+" кодов"],
    ["В этом файле",rows.length+" кодов"],
    ["Данные на",(RD.warehouse&&RD.warehouse.date)||"—"],
    ["Файл сформирован",new Date().toISOString().slice(0,10)]]);
  info['!cols']=[{wch:26},{wch:78}];
  XLSX.utils.book_append_sheet(wbk,info,'Как заполнять');
  XLSX.writeFile(wbk,OUT);

  const need=rows.filter(r=>r.need>0), onWh=rows.filter(r=>r.whAll>0);
  console.log('Файл: '+OUT);
  console.log('Пропущено «На вывод»: '+skippedOut+(withOut?' (флаг --all — включены)':'')); 
  console.log('Кодов без полной вместимости: '+rows.length
    +' · из них нужен подсорт: '+need.length+' · есть на складе: '+onWh.length);
  console.log('Вместимость известна: '+Object.keys(P).length+' кодов');
  const byRank={}; rows.forEach(r=>byRank[r.why]=(byRank[r.why]||0)+1);
  console.log('\nпо важности:'); Object.entries(byRank).forEach(([k,v])=>console.log('   '+String(v).padStart(4)+'  '+k));
  const partial=rows.filter(r=>r.palWb!==''||r.palOz!=='');
  console.log('заполнено частично (одна площадка есть, вторая нет): '+partial.length);
  console.log('\nСАМЫЕ ВАЖНЫЕ (нужен подсорт):');
  need.slice(0,15).forEach(r=>console.log('  '+r.s.padEnd(9)+' склад '+String(r.whAll).padStart(6)
    +' · нужно '+String(r.need).padStart(5)+' · продаж '+r.spd.toFixed(1)+'/дн  '+(r.name||'').slice(0,34)));
  console.log('\nБЕЗ ПОДСОРТА, но лежит на складе (топ по остатку):');
  onWh.filter(r=>!r.need).slice(0,10).forEach(r=>console.log('  '+r.s.padEnd(9)+' склад '+String(r.whAll).padStart(6)
    +'  '+(r.name||'').slice(0,40)));
})();
