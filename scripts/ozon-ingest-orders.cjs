// Разбирает отчёты Озона «Заказы» (xlsx/csv) → свод по (дата+артикул) и по товарам.
// Пишет decrypted/ozon-orders.json: {byDateArt, byDate, byDateNet, perArt, perArtNet, statuses}.
// «Наши» — артикул ∈ supplierCode WB-каталога. Дедуп по «Номер отправления + SKU»
// (НЕ по дате: форматы дат различаются — csv Д/М, xlsx М/Д, определяем пофайлово).
// Заказано = все статусы (gross); net = без «Отменён» → процент выкупа = net/gross.
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const ROOT=path.join(__dirname,'..'), OUT=path.join(ROOT,'decrypted');
let files=process.argv.slice(2);
const RESET=files.includes('--reset'); files=files.filter(f=>f!=='--reset');
if(!files.length){console.error('usage: node scripts/ozon-ingest-orders.cjs [--reset] <файл1> <файл2> ...');process.exit(1);}
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+"\nglobalThis.__C=REAL_DATA.catalog;",ctx);
const wbSup=new Set(ctx.__C.map(x=>(''+(x.supplierCode||'')).trim()).filter(Boolean));
function num(v){const n=parseFloat((''+v).replace(/\s/g,'').replace(',','.'));return isNaN(n)?0:n;}
function load(f){ if(f.endsWith('.csv')){const t=fs.readFileSync(f,'utf8');const sep=(t.split(/\r?\n/)[0].split(';').length>2)?';':',';return XLSX.read(t,{type:'string',FS:sep,raw:false});}
  return XLSX.read(fs.readFileSync(f),{type:'buffer',cellStyles:false,cellFormula:false}); }
// Разделитель даты бывает и «/» (7/24/26), и «.» (22.07.2026) — зависит от выгрузки.
// Порядок полей (MD/DM) определяется отдельно, пофайлово, через detectFmt.
function parts(s,fmt){const p=(''+s).trim().split(' ')[0].split(/[/.]/);if(p.length!==3)return null;let a=+p[0],b=+p[1],y=+p[2];if(!(a>0&&b>0&&y>0))return null;if(y<100)y+=2000;const m=fmt==='MD'?a:b,d=fmt==='MD'?b:a;if(!(m>=1&&m<=12&&d>=1&&d<=31))return null;return{y,m,d};}
function iso(o){return o.y+'-'+String(o.m).padStart(2,'0')+'-'+String(o.d).padStart(2,'0');}
function detectFmt(strs){const r={};for(const f of ['MD','DM']){let ok=true,mn=null,mx=null;for(const s of strs){const o=parts(s,f);if(!o){ok=false;break;}const t=Date.UTC(o.y,o.m-1,o.d);if(mn==null||t<mn)mn=t;if(mx==null||t>mx)mx=t;}if(ok)r[f]=(mx-mn)/864e5;}const k=Object.keys(r);return k.length?k.sort((a,b)=>r[a]-r[b])[0]:'MD';}
// Все наши строки из переданных файлов, ключ = «номер отправления + SKU».
// Внутри одного прогона повтор ключа отбрасывается сразу; сверка с уже загруженным —
// ниже, по сохранённому в своде списку ключей.
const rowsByKey=new Map();
const newDates=new Set();
let ours=0;
for(const f of files){
  const wb=load(f);const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:false,defval:''});
  const H=rows[0];const iOtpr=H.indexOf('Номер отправления'),iAcc=H.indexOf('Принят в обработку'),iStatus=H.indexOf('Статус'),iArt=H.indexOf('Артикул'),iSku=H.indexOf('SKU'),iQty=H.indexOf('Количество'),iPrice=H.indexOf('Ваша цена');
  const ds=[];for(let i=1;i<rows.length;i++){const a=(''+(rows[i][iArt]||'')).trim();if(wbSup.has(a)){const s=(''+(rows[i][iAcc]||'')).trim();if(s)ds.push(s);}}
  const fmt=detectFmt(ds);
  for(let i=1;i<rows.length;i++){const r=rows[i];const a=(''+(r[iArt]||'')).trim();if(!wbSup.has(a))continue;
    const key=(''+(r[iOtpr]||''))+'|'+(''+(r[iSku]||''));if(rowsByKey.has(key))continue;
    const o=parts(r[iAcc],fmt);if(!o)continue;const d=iso(o);newDates.add(d);
    const q=num(r[iQty])||1, st=(''+(r[iStatus]||'')).trim(), rub=num(r[iPrice]);  // «Ваша цена» = стоимость заказа
    rowsByKey.set(key,{d,a,q,st,rub}); ours++;
  }
  process.stderr.write('.'+f.split('/').pop().slice(0,8)+'('+fmt+')');
}
// Мерж в существующий снимок — АДДИТИВНЫЙ, с дедупом по «номер отправления + SKU».
// Раньше дни из новых файлов ЗАМЕЩАЛИ те же дни снимка. Это ломалось, когда продавец
// дробит большую выгрузку на части: стыковой день попадал в оба файла лишь частично,
// и вторая загрузка затирала первую половину дня (реальный случай: 15.06 — 144 → 53 шт).
// Поэтому ключи отправлений хранятся В САМОМ своде (M.keys) и повтор просто пропускается:
// один и тот же файл можно грузить сколько угодно раз, части склеиваются без потерь.
// Флаг --reset очищает накопитель (нужен, если WB/Озон прислали исправленную историю).
const outPath=path.join(OUT,'ozon-orders.json');
let ex={}; try{ if(!RESET && fs.existsSync(outPath)) ex=JSON.parse(fs.readFileSync(outPath,'utf8')); }catch(e){ ex={}; }
const M={
  byDateArt:Object.assign({},ex.byDateArt||{}), byDateArtNet:Object.assign({},ex.byDateArtNet||{}),
  byDateArtRub:Object.assign({},ex.byDateArtRub||{}), byDateArtBuyRub:Object.assign({},ex.byDateArtBuyRub||{}),
  byDate:Object.assign({},ex.byDate||{}), byDateNet:Object.assign({},ex.byDateNet||{}),
  statuses:Object.assign({},ex.statuses||{}),
};
const known=new Set(ex.keys||[]);
let skipped=0;
for(const [key,rec] of rowsByKey){
  if(known.has(key)){ skipped++; continue; }
  known.add(key);
  const {d,a,q,st,rub}=rec;
  M.byDate[d]=(M.byDate[d]||0)+q; M.byDateArt[d+'_'+a]=(M.byDateArt[d+'_'+a]||0)+q;
  M.byDateArtRub[d+'_'+a]=(M.byDateArtRub[d+'_'+a]||0)+rub;
  if(st==='Доставлен') M.byDateArtBuyRub[d+'_'+a]=(M.byDateArtBuyRub[d+'_'+a]||0)+rub;
  if(st!=='Отменён'){ M.byDateNet[d]=(M.byDateNet[d]||0)+q; M.byDateArtNet[d+'_'+a]=(M.byDateArtNet[d+'_'+a]||0)+q; }
  M.statuses[st]=(M.statuses[st]||0)+q;
}
M.keys=[...known];
// perArt/perArtNet пересобираем из по-дневных карт (кросс-датные — иначе накопится задвоение)
M.perArt={}; for(const [k,v] of Object.entries(M.byDateArt)){ const a=k.slice(11); M.perArt[a]=(M.perArt[a]||0)+v; }
M.perArtNet={}; for(const [k,v] of Object.entries(M.byDateArtNet)){ const a=k.slice(11); M.perArtNet[a]=(M.perArtNet[a]||0)+v; }
M.builtAt=new Date().toISOString();
fs.writeFileSync(outPath,JSON.stringify(M));
const totG=Object.values(M.byDate).reduce((a,b)=>a+b,0), totN=Object.values(M.byDateNet).reduce((a,b)=>a+b,0);
const allDates=[...new Set(Object.keys(M.byDateArt).map(k=>k.slice(0,10)))].sort();
console.log('\nozon-orders.json'+(RESET?' (ПЕРЕСОБРАН с нуля)':' (мерж)')+': наших строк из файлов',ours,
  '· уже были в своде (пропущено):',skipped,'· добавлено:',(ours-skipped));
console.log('  дни в файлах:',[...newDates].sort()[0],'…',[...newDates].sort().slice(-1)[0]);
console.log('  итог снимка: дней',allDates.length,'['+allDates[0]+' … '+allDates[allDates.length-1]+'] · заказано',totG,'· net',totN,'· выкуп%',(totN/totG*100).toFixed(1),'· артикулов',Object.keys(M.perArt).length);
