// ОПЛАТА ЗА ЗАКАЗ НА ОЗОНЕ: у КАКИХ товаров она включена и по какой ставке.
// Пишет REAL_DATA.ozon.meta.ozzOn. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО (поймано 09.10.2026, цена вопроса ~20 тыс ₽/день).
// Ozon списывает 5% с КАЖДОГО заказа по умолчанию — отключить их нельзя, это пол.
// Выгрузка XWAY «Расход» этих 5% НЕ ПОКАЗЫВАЕТ: она видит только то, что прошло через
// её кампании. Доказательство прямое — у 487176 за 07.10 весь расход в выгрузке 3 600 ₽,
// а 5% от его продаж (73 349 ₽) это 3 667 ₽, то есть больше всей выгрузки; и у товара
// вообще без кампаний (487160) XWAY показывает «расход за месяц 0 ₽» при живых продажах.
//
// А дашборд устроен так: есть факт XWAY — ставка из юнит-экономики к товару НЕ применяется
// (иначе двойной счёт с рекламой, которая в отчёт юнит-экономики уже вошла). В итоге у
// товаров «клики есть, оплата за заказ выключена» базовые 5% терялись с обеих сторон, и
// прибыль Озона в дашборде была ЗАВЫШЕНА. Замер 09.10: 16 таких товаров, недоучёт
// 20 116 ₽/день — 10% всей маржи кабинета. Шесть товаров из показанных «в плюсе» на деле
// были в минусе (487190 −24,4%, 487180 −11,1%, 487199 −7,4% …).
//
// ПОЧЕМУ НУЖЕН ИМЕННО СПИСОК, А НЕ ОБЩЕЕ ПРАВИЛО. Ставка за заказ зависит от того, какие
// каналы включены у ТОВАРА (подтверждено продавцом у Ozon 09.10.2026):
//   кликов нет, оплата за заказ выключена        → 5%
//   клики включены, оплата за заказ выключена    → 5% + клики
//   клики включены И оплата за заказ включена    → 10% + клики
//   только оплата за заказ, без кликов           → 23%
// В первых двух случаях 5% платятся СВЕРХ выгрузки XWAY и их надо добавлять.
// В последних двух ставка (10 или 23%) ЗАМЕНЯЕТ эти 5% и уже сидит внутри выгрузки —
// добавлять нельзя, получится двойной счёт. Отличить одно от другого по данным нельзя:
// в выгрузке обе части слиты в одну колонку «Расход». Поэтому список ведётся руками.
//
// КТО ЕГО ЗАПОЛНЯЕТ. Продавец — он единственный видит тумблеры в XWAY (список товаров,
// колонка «Выбранные товары · Оплата за заказ»). Сообщает при каждом включении/выключении.
// Состояние на 09.10.2026: включена у ТРЁХ товаров — 487182 (10%), 487184 (23%), 493370 (23%).
//
// Использование:
//   node scripts/ozon-ozz.cjs list
//   node scripts/ozon-ozz.cjs set "487182=10, 487184=23, 493370=23"   ← заменяет список целиком
//   node scripts/ozon-ozz.cjs add "493373=10"                          ← добавляет/меняет один
//   node scripts/ozon-ozz.cjs drop "487184, 493370"                    ← выключили у товара
//   node scripts/ozon-ozz.cjs clear                                    ← выключена у всех
//
// Дальше: node scripts/ozon-finance.cjs (проверить цифры) && node scripts/encrypt.cjs <код>

const fs=require('fs'), vm=require('vm'), path=require('path');
const OUT=path.join(__dirname,'..','decrypted');

const argv=process.argv.slice(2);
const cmd=(argv[0]||'list').toLowerCase();

const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD, O=RD.ozon;
if(!O) throw new Error('в снимке нет блока Озона');
O.meta=O.meta||{};

const today=new Date().toISOString().slice(0,10);
const cur=(O.meta.ozzOn && O.meta.ozzOn.bySup && typeof O.meta.ozzOn.bySup==='object')
  ? Object.assign({},O.meta.ozzOn.bySup) : {};
const nameOf=s=>{ const c=(O.catalog||[]).find(z=>String(z.sku)===String(s)); return c? (c.name||'') : ''; };
const known=new Set((O.catalog||[]).map(z=>String(z.sku)));

// «487182=10, 487184=23» → {487182:10, 487184:23}
function parsePairs(str){
  const out={};
  String(str||'').split(/[,;\n]+/).forEach(p=>{
    const t=p.trim(); if(!t) return;
    const m=t.match(/^(\S+?)\s*[=:]\s*([\d.,]+)\s*%?$/);
    if(!m) throw new Error('не разобрал «'+t+'» — нужно «код=ставка», например «487182=10»');
    const sup=m[1].replace(/[\s,]/g,''), rate=parseFloat(m[2].replace(',','.'));
    if(!(rate>0&&rate<=100)) throw new Error('ставка «'+m[2]+'» вне диапазона 0–100%');
    out[sup]=rate;
  });
  return out;
}
const parseCodes=str=>String(str||'').split(/[,;\s]+/).map(s=>s.replace(/[\s,]/g,'')).filter(Boolean);

function save(){
  O.meta.ozzOn={bySup:cur, setAt:today,
    note:'Товары, у которых на Озоне ВКЛЮЧЕНА оплата за заказ (ключ — артикул продавца = код 1С, '
      +'значение — ставка % от заказа). У них ставка заменяет базовые 5% и уже сидит в выгрузке XWAY. '
      +'У всех ОСТАЛЬНЫХ товаров с фактом XWAY базовые 5% в выгрузку не попадают и добавляются сверху '
      +'(ozApplyAdFact в index.html, adFact/baseOn в scripts/ozon-finance.cjs — держать синхронно).'};
  fs.writeFileSync(path.join(OUT,'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
}

function show(){
  const ks=Object.keys(cur).sort();
  if(!ks.length){
    console.log('Оплата за заказ не включена НИ У ОДНОГО товара.');
    console.log('Значит у всех товаров с выгрузкой XWAY базовые 5% добавляются к факту сверху.');
  }else{
    console.log('ОПЛАТА ЗА ЗАКАЗ ВКЛЮЧЕНА — '+ks.length+' товаров'
      +(O.meta.ozzOn&&O.meta.ozzOn.setAt? ' (список от '+O.meta.ozzOn.setAt+')':'')+':');
    ks.forEach(s=>{
      const warn=known.has(s)? '' : '   ← НЕТ В КАТАЛОГЕ ОЗОНА, проверьте код';
      console.log('   '+s.padEnd(10)+String(cur[s]+'%').padStart(5)+'   '+nameOf(s).slice(0,46)+warn);
    });
    console.log('   У этих ставка ЗАМЕНЯЕТ базовые 5% и уже входит в выгрузку XWAY — сверху ничего не добавляем.');
    console.log('   У всех остальных товаров с фактом XWAY базовые 5% добавляются к расходу.');
  }
  // сколько товаров сейчас с фактом XWAY — чтобы видеть масштаб
  const parts=((O.meta.adSpend&&O.meta.adSpend.parts)||[]);
  const withFact=new Set(); parts.forEach(p=>Object.keys(p.bySup||{}).forEach(a=>withFact.add(a)));
  if(withFact.size){
    const add=[...withFact].filter(a=>cur[a]==null).length;
    console.log('\nТоваров с выгрузками XWAY: '+withFact.size+' · из них базовые 5% добавляются: '+add);
  }
}

if(cmd==='list'){ show(); process.exit(0); }

if(cmd==='set'){
  const next=parsePairs(argv[1]);
  if(!Object.keys(next).length) throw new Error('пустой список; чтобы очистить — команда clear');
  Object.keys(cur).forEach(k=>delete cur[k]);
  Object.assign(cur,next);
}else if(cmd==='add'){
  Object.assign(cur,parsePairs(argv[1]));
}else if(cmd==='drop'){
  const codes=parseCodes(argv[1]);
  if(!codes.length) throw new Error('usage: node scripts/ozon-ozz.cjs drop "487184, 493370"');
  codes.forEach(c=>{ if(cur[c]==null) console.log('   '+c+' — и так не в списке, пропущен'); delete cur[c]; });
}else if(cmd==='clear'){
  Object.keys(cur).forEach(k=>delete cur[k]);
}else{
  console.error('usage: node scripts/ozon-ozz.cjs list | set "код=ставка, …" | add "код=ставка" | drop "коды" | clear');
  process.exit(1);
}

const unknown=Object.keys(cur).filter(s=>!known.has(s));
if(unknown.length) console.log('ВНИМАНИЕ: нет в каталоге Озона — '+unknown.join(', ')+' (записаны, но проверьте коды)');

save();
show();
console.log('\nДальше: node scripts/ozon-finance.cjs (проверить цифры) && node scripts/encrypt.cjs <код>');
