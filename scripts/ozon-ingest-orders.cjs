// Разбирает отчёты Озона «Заказы» (xlsx/csv) → свод по (дата+артикул) и по товарам.
// Пишет decrypted/ozon-orders.json: {byDateArt, byDate, byDateNet, perArt, perArtNet, statuses}.
// «Наши» — артикул ∈ supplierCode WB-каталога. Дедуп по «Номер отправления + SKU»
// (НЕ по дате: форматы дат различаются — csv Д/М, xlsx М/Д, определяем пофайлово).
// Заказано = все статусы (gross); net = без «Отменён» → процент выкупа = net/gross.
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const ROOT=path.join(__dirname,'..'), OUT=path.join(ROOT,'decrypted');
const files=process.argv.slice(2);
if(!files.length){console.error('usage: node scripts/ozon-ingest-orders.cjs <файл1> <файл2> ...');process.exit(1);}
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+"\nglobalThis.__C=REAL_DATA.catalog;",ctx);
const wbSup=new Set(ctx.__C.map(x=>(''+(x.supplierCode||'')).trim()).filter(Boolean));
function num(v){const n=parseFloat((''+v).replace(/\s/g,'').replace(',','.'));return isNaN(n)?0:n;}
function load(f){ if(f.endsWith('.csv')){const t=fs.readFileSync(f,'utf8');const sep=(t.split(/\r?\n/)[0].split(';').length>2)?';':',';return XLSX.read(t,{type:'string',FS:sep,raw:false});}
  return XLSX.read(fs.readFileSync(f),{type:'buffer',cellStyles:false,cellFormula:false}); }
function parts(s,fmt){const p=(''+s).trim().split(' ')[0].split('/');if(p.length!==3)return null;let a=+p[0],b=+p[1],y=+p[2];if(y<100)y+=2000;const m=fmt==='MD'?a:b,d=fmt==='MD'?b:a;if(!(m>=1&&m<=12&&d>=1&&d<=31))return null;return{y,m,d};}
function iso(o){return o.y+'-'+String(o.m).padStart(2,'0')+'-'+String(o.d).padStart(2,'0');}
function detectFmt(strs){const r={};for(const f of ['MD','DM']){let ok=true,mn=null,mx=null;for(const s of strs){const o=parts(s,f);if(!o){ok=false;break;}const t=Date.UTC(o.y,o.m-1,o.d);if(mn==null||t<mn)mn=t;if(mx==null||t>mx)mx=t;}if(ok)r[f]=(mx-mn)/864e5;}const k=Object.keys(r);return k.length?k.sort((a,b)=>r[a]-r[b])[0]:'MD';}
const seen=new Set();
const byDateArt={},byDateArtNet={},byDate={},byDateNet={},perArt={},perArtNet={},statuses={};
const byDateArtRub={},byDateArtBuyRub={};  // ₽: заказано (все) / выкуплено (статус «Доставлен»)
const newDates=new Set();   // дни, встреченные в переданных файлах — их данные ПЕРЕЗАПИШУТ те же дни снимка
let ours=0;
for(const f of files){
  const wb=load(f);const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:false,defval:''});
  const H=rows[0];const iOtpr=H.indexOf('Номер отправления'),iAcc=H.indexOf('Принят в обработку'),iStatus=H.indexOf('Статус'),iArt=H.indexOf('Артикул'),iSku=H.indexOf('SKU'),iQty=H.indexOf('Количество'),iPrice=H.indexOf('Ваша цена');
  const ds=[];for(let i=1;i<rows.length;i++){const a=(''+(rows[i][iArt]||'')).trim();if(wbSup.has(a)){const s=(''+(rows[i][iAcc]||'')).trim();if(s)ds.push(s);}}
  const fmt=detectFmt(ds);
  for(let i=1;i<rows.length;i++){const r=rows[i];const a=(''+(r[iArt]||'')).trim();if(!wbSup.has(a))continue;
    const key=(''+(r[iOtpr]||''))+'|'+(''+(r[iSku]||''));if(seen.has(key))continue;seen.add(key);
    const o=parts(r[iAcc],fmt);if(!o)continue;const d=iso(o);newDates.add(d);const q=num(r[iQty])||1;const st=(''+(r[iStatus]||'')).trim();
    const net = st!=='Отменён';
    statuses[st]=(statuses[st]||0)+q; ours++;
    byDate[d]=(byDate[d]||0)+q; byDateArt[d+'_'+a]=(byDateArt[d+'_'+a]||0)+q; perArt[a]=(perArt[a]||0)+q;
    const rub=num(r[iPrice]);   // «Ваша цена» = стоимость заказа (qty на Озоне = 1)
    byDateArtRub[d+'_'+a]=(byDateArtRub[d+'_'+a]||0)+rub;
    if(st==='Доставлен') byDateArtBuyRub[d+'_'+a]=(byDateArtBuyRub[d+'_'+a]||0)+rub;   // выкуплено = доставлено
    if(net){ byDateNet[d]=(byDateNet[d]||0)+q; perArtNet[a]=(perArtNet[a]||0)+q; byDateArtNet[d+'_'+a]=(byDateArtNet[d+'_'+a]||0)+q; }
  }
  process.stderr.write('.'+f.split('/').pop().slice(0,8)+'('+fmt+')');
}
// Мерж по дням в существующий снимок (как у ВБ): дни из файлов ПЕРЕЗАПИСЫВАЮТ те же дни,
// прочие дни снимка сохраняются. Так подённые выгрузки Озона накапливаются, а не затирают историю.
const outPath=path.join(OUT,'ozon-orders.json');
let ex={}; try{ if(fs.existsSync(outPath)) ex=JSON.parse(fs.readFileSync(outPath,'utf8')); }catch(e){ ex={}; }
const mergeDA=(base,add)=>{ const o={}; for(const [k,v] of Object.entries(base||{})){ if(!newDates.has(k.slice(0,10))) o[k]=v; } for(const [k,v] of Object.entries(add)) o[k]=(o[k]||0)+v; return o; };
const mergeD =(base,add)=>{ const o={}; for(const [k,v] of Object.entries(base||{})){ if(!newDates.has(k)) o[k]=v; } for(const [k,v] of Object.entries(add)) o[k]=(o[k]||0)+v; return o; };
const M={
  byDateArt:mergeDA(ex.byDateArt,byDateArt), byDateArtNet:mergeDA(ex.byDateArtNet,byDateArtNet),
  byDateArtRub:mergeDA(ex.byDateArtRub,byDateArtRub), byDateArtBuyRub:mergeDA(ex.byDateArtBuyRub,byDateArtBuyRub),
  byDate:mergeD(ex.byDate,byDate), byDateNet:mergeD(ex.byDateNet,byDateNet),
};
// perArt/perArtNet пересобираем из слитых по-дневных карт (кросс-датные — иначе накопится задвоение)
M.perArt={}; for(const [k,v] of Object.entries(M.byDateArt)){ const a=k.slice(11); M.perArt[a]=(M.perArt[a]||0)+v; }
M.perArtNet={}; for(const [k,v] of Object.entries(M.byDateArtNet)){ const a=k.slice(11); M.perArtNet[a]=(M.perArtNet[a]||0)+v; }
// statuses по статусам не раскладывается по дням — держим как best-effort (для новых дней аддитивно);
// метрики дашборда (всего/отменено/выкуп%) считаются из byDate/byDateNet, а не из statuses.
M.statuses=Object.assign({},ex.statuses||{}); for(const [k,v] of Object.entries(statuses)) M.statuses[k]=(M.statuses[k]||0)+v;
M.builtAt=new Date().toISOString();
fs.writeFileSync(outPath,JSON.stringify(M));
const totG=Object.values(M.byDate).reduce((a,b)=>a+b,0), totN=Object.values(M.byDateNet).reduce((a,b)=>a+b,0);
const allDates=[...new Set(Object.keys(M.byDateArt).map(k=>k.slice(0,10)))].sort();
console.log('\nozon-orders.json (мерж): строк из файлов',ours,'· новые дни:',[...newDates].sort().join(', '));
console.log('  итог снимка: дней',allDates.length,'['+allDates[0]+' … '+allDates[allDates.length-1]+'] · заказано',totG,'· net',totN,'· выкуп%',(totN/totG*100).toFixed(1),'· артикулов',Object.keys(M.perArt).length);
