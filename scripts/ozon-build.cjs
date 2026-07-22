// Собирает блок REAL_DATA.ozon (каталог Озона + заказы по дням + остатки) и вписывает
// его в decrypted/wb-data.js. Источники:
//   - каталог: лист «Июль» рабочего файла Озона (Артикул + Наименование + Вид товара);
//   - заказы: decrypted/ozon-orders.json (свод byDateArt из отчётов «Заказы»);
//   - остатки: отчёт Озона «Остатки на складах», лист «Товары» (опционально, 2-й арг).
// Артикул Озона = арт. поставщика = WB supplierCode → связка с ВБ (поле wbSku).
//
// Использование: node scripts/ozon-build.cjs <файл_с_листом_Июль.xlsx> [остатки.xlsx] [дата_остатков=сегодня]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const ROOT=path.join(__dirname,'..'), OUT=path.join(ROOT,'decrypted');
// Первый арг — файл с листом «Июль» (пересобрать каталог) ИЛИ «--reuse» (взять существующий
// каталог Озона из снимка: сохранить name/category/wbSku/ozonSku, обновить только заказы+остатки).
let _args=process.argv.slice(2), reuse=false;
if(_args[0]==='--reuse'){ reuse=true; _args=_args.slice(1); }
const catalogFile = reuse? null : _args[0];
const stockFile = reuse? _args[0] : _args[1];
const stockDate = (reuse? _args[1] : _args[2]) || new Date().toISOString().slice(0,10);
if(!reuse && !catalogFile){console.error('usage: node scripts/ozon-build.cjs (<файл_Июль.xlsx> | --reuse) [остатки.xlsx] [дата]');process.exit(1);}
function num(v){const n=parseFloat((''+v).replace(/[\s ]/g,'').replace(',','.'));return isNaN(n)?0:n;}

// 1) WB каталог → карта supplierCode → sku
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const supToWb={}, wbCatBySku={};RD.catalog.forEach(c=>{const s=(''+(c.supplierCode||'')).trim();if(s)supToWb[s]=c.sku; wbCatBySku[c.sku]=c.category;});

// 2) Озон-каталог: из листа «Июль» (обычный режим) ИЛИ из существующего снимка (--reuse)
const ozCat=[]; const byA={}; const seen=new Set();
function ensure(art){ if(seen.has(art)) return byA[art]; seen.add(art);
  const c={sku:art, name:art, category:'Без категории', wbSku:supToWb[art]||null, ozStock:0, ozTransit:0};
  byA[art]=c; ozCat.push(c); return c; }
if(reuse){
  // сохраняем существующий каталог целиком (name/category/wbSku/ozonSku и пр.), обнуляем только
  // остатки — их зальёт отчёт остатков ниже; товар без остатка в отчёте останется с 0.
  const prev=(RD.ozon&&RD.ozon.catalog)||[];
  if(!prev.length){ console.error('--reuse: в снимке нет каталога Озона. Соберите его один раз из файла «Июль».'); process.exit(1); }
  prev.forEach(c=>{ const cc=Object.assign({},c); cc.ozStock=0; cc.ozTransit=0; byA[cc.sku]=cc; ozCat.push(cc); seen.add(cc.sku); });
} else {
  const wb=XLSX.read(fs.readFileSync(catalogFile),{type:'buffer',cellStyles:false,cellFormula:false});
  const rows=XLSX.utils.sheet_to_json(wb.Sheets['Июль'],{header:1,raw:false,defval:''});
  for(let i=1;i<rows.length;i++){
    const art=(''+(rows[i][0]||'')).trim(); if(!art||art==='Всего') continue;
    const c=ensure(art); c.name=(''+(rows[i][1]||art)).trim(); c.category=(''+(rows[i][2]||'')).trim()||'Без категории';
  }
}

// 3) Заказы по дням из свода
const ord=JSON.parse(fs.readFileSync(path.join(OUT,'ozon-orders.json'),'utf8'));
const dates=[...new Set(Object.keys(ord.byDateArt).map(k=>k.split('_')[0]))].sort();
const dIdx={};dates.forEach((d,i)=>dIdx[d]=i);
Object.keys(ord.byDateArt).map(k=>k.slice(11)).forEach(a=>ensure(a)); // артикулы с заказами
const byArt={}; ozCat.forEach(c=>{ byArt[c.sku]=new Array(dates.length).fill(0); });
Object.entries(ord.byDateArt).forEach(([k,q])=>{ const d=k.slice(0,10),a=k.slice(11); byArt[a][dIdx[d]]=q; });
// ₽ по дням: money = {дата:{арт:[заказано₽,выкуплено₽]}} (выкуплено = статус «Доставлен»)
const ozMoney={};
Object.entries(ord.byDateArtRub||{}).forEach(([k,v])=>{ const d=k.slice(0,10),a=k.slice(11); (ozMoney[d]||(ozMoney[d]={}))[a]=[Math.round(v),0]; });
Object.entries(ord.byDateArtBuyRub||{}).forEach(([k,v])=>{ const d=k.slice(0,10),a=k.slice(11); const m=(ozMoney[d]||(ozMoney[d]={})); if(!m[a])m[a]=[0,0]; m[a][1]=Math.round(v); });

// 4) Остатки (лист «Товары»): 0 Артикул · 9 Доступно к продаже · 19 В поставках в пути
//    6 Дней до конца остатка (озоновский) · 7 Среднесут. продажи 28д
let stockRows=0, stockSum=0;
if(stockFile){
  const swb=XLSX.read(fs.readFileSync(stockFile),{type:'buffer',cellStyles:false,cellFormula:false});
  const sr=XLSX.utils.sheet_to_json(swb.Sheets['Товары'],{header:1,raw:false,defval:''});
  for(let i=4;i<sr.length;i++){ const r=sr[i]; const art=(''+(r[0]||'')).trim(); if(!art) continue;
    // берём только наши: уже в каталоге Озона ИЛИ есть как арт.поставщика ВБ
    if(!byA[art] && !supToWb[art]) continue;
    const c=ensure(art); if(c.name===art){ const nm=(''+(r[1]||'')).trim(); if(nm) c.name=nm; }
    c.ozStock=num(r[9]); c.ozTransit=num(r[19]);
    const dl=num(r[6]); if(dl>0) c.ozDaysLeftReport=Math.round(dl);
    const av=num(r[7]); if(av>0) c.ozAvg28=av;
    stockRows++; stockSum+=c.ozStock;
    if(!byArt[art]) byArt[art]=new Array(dates.length).fill(0);
  }
}

// Категория: у связанных товаров берём ВБ-категорию — единая классификация на обеих
// площадках (Озон-«вид товара» иначе не совпадает: «Пушкары»↔«Каталка» и т.п.).
ozCat.forEach(c=>{ if(c.wbSku && wbCatBySku[c.wbSku]) c.category = wbCatBySku[c.wbSku]; });

// Процент выкупа: окно 14 дней, заканчивающееся за 7 дней до последней даты.
// Последние 7 дней пропускаем — заказы ещё в пути, выкуп «не дозрел» (статус «Доставляется»).
// Если истории мало (< HOLD+1 дней) — берём весь период.
const HOLD=7, WIN=14;
const endIdx=dates.length-1-HOLD, startIdx=Math.max(0,endIdx-WIN+1);
const winDates = endIdx>=0 ? dates.slice(startIdx,endIdx+1) : dates.slice();
const winSet=new Set(winDates);
const wGross={},wNet={}; let wGrossAll=0,wNetAll=0;
Object.entries(ord.byDateArt||{}).forEach(([k,q])=>{ if(winSet.has(k.slice(0,10))){const a=k.slice(11);wGross[a]=(wGross[a]||0)+q;wGrossAll+=q;} });
Object.entries(ord.byDateArtNet||{}).forEach(([k,q])=>{ if(winSet.has(k.slice(0,10))){const a=k.slice(11);wNet[a]=(wNet[a]||0)+q;wNetAll+=q;} });
const buyoutAll = wGrossAll>0 ? wNetAll/wGrossAll : 1;
ozCat.forEach(c=>{ const g=wGross[c.sku]||0, n=wNet[c.sku]||0;
  c.ozBuyout = g>=10 ? +(n/g).toFixed(4) : +buyoutAll.toFixed(4); });
const buyoutWindow = winDates.length ? winDates[0]+'…'+winDates[winDates.length-1] : null;

RD.ozon={
  catalog:ozCat,
  orderSeries:{dates,byArt,money:ozMoney},
  ordersMeta:{period:dates[0]+'…'+dates[dates.length-1], totalOrdered:ord.statuses?Object.values(ord.statuses).reduce((a,b)=>a+b,0):0, cancelled:(ord.statuses&&ord.statuses['Отменён'])||0},
  meta:{ stockDate: stockFile? stockDate : (RD.ozon&&RD.ozon.meta&&RD.ozon.meta.stockDate)||null, buyoutAll:+buyoutAll.toFixed(4), buyoutWindow }
};

// 5) переписать wb-data.js
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const linked=ozCat.filter(c=>c.wbSku).length;
console.log('REAL_DATA.ozon собран:');
console.log('  каталог Озона:',ozCat.length,'товаров · связано с ВБ:',linked,'· без связки:',ozCat.length-linked);
console.log('  заказы: дней',dates.length,'('+dates[0]+'…'+dates[dates.length-1]+') · товаров с заказами:',ozCat.filter(c=>byArt[c.sku]&&byArt[c.sku].some(x=>x>0)).length);
console.log('  остатки:',stockFile?('строк '+stockRows+' · сумма «Доступно» '+stockSum+' шт · дата '+stockDate):'(файл не передан)');
console.log('  товаров с остатком >0:',ozCat.filter(c=>c.ozStock>0).length);
console.log('  % выкупа: окно',buyoutWindow,'· общий',Math.round(buyoutAll*100)+'%');
