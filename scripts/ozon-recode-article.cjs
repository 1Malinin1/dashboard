// Точечная замена кода товара в связке ВБ↔Озон: <старый код 1С> → <новый>.
// Нужна, когда на Озоне товар переехал на другую карточку/артикул и продавец решил,
// какой код считать актуальным. Делает три вещи:
//   1) меняет supplierCode у ВБ-товара (это и есть ключ связки с Озоном);
//   2) пересобирает записи заказов Озона по НОВОМУ артикулу прямо из исходных файлов
//      (при первичной загрузке они отсеивались как «не наши»);
//   3) выкидывает из свода заказы по СТАРОМУ артикулу.
// Использование: node scripts/ozon-recode-article.cjs <старый> <новый> <файлы заказов…>
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const [oldCode,newCode,...files]=process.argv.slice(2);
if(!oldCode||!newCode){console.error('usage: node scripts/ozon-recode-article.cjs <старый> <новый> <файлы…>');process.exit(1);}

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const targets=RD.catalog.filter(c=>(''+(c.supplierCode||'')).trim()===oldCode);
if(!targets.length){console.error('в каталоге ВБ нет товара с кодом 1С '+oldCode);process.exit(1);}
targets.forEach(c=>{ console.log('ВБ '+c.sku+' · «'+(c.name||'').slice(0,44)+'» · код 1С '+oldCode+' → '+newCode);
  c.supplierCode=newCode; });

function num(v){const n=parseFloat((''+v).replace(/\s/g,'').replace(',','.'));return isNaN(n)?0:n;}
function load(f){ if(f.endsWith('.csv')){const t=fs.readFileSync(f,'utf8');const sep=(t.split(/\r?\n/)[0].split(';').length>2)?';':',';return XLSX.read(t,{type:'string',FS:sep,raw:false});}
  return XLSX.read(fs.readFileSync(f),{type:'buffer',cellStyles:false,cellFormula:false}); }
function parts(s,fmt){const p=(''+s).trim().split(' ')[0].split(/[/.]/);if(p.length!==3)return null;let a=+p[0],b=+p[1],y=+p[2];
  if(!(a>0&&b>0&&y>0))return null;if(y<100)y+=2000;const m=fmt==='MD'?a:b,d=fmt==='MD'?b:a;
  if(!(m>=1&&m<=12&&d>=1&&d<=31))return null;return{y,m,d};}
const iso=o=>o.y+'-'+String(o.m).padStart(2,'0')+'-'+String(o.d).padStart(2,'0');
function detectFmt(strs){const r={};for(const f of ['MD','DM']){let ok=true,mn=null,mx=null;
  for(const s of strs){const o=parts(s,f);if(!o){ok=false;break;}const t=Date.UTC(o.y,o.m-1,o.d);
    if(mn==null||t<mn)mn=t;if(mx==null||t>mx)mx=t;}if(ok)r[f]=(mx-mn)/864e5;}
  const k=Object.keys(r);return k.length?k.sort((a,b)=>r[a]-r[b])[0]:'MD';}

const P=path.join(OUT,'ozon-orders.json');
const M=JSON.parse(fs.readFileSync(P,'utf8'));
// 1) выкидываем старый артикул отовсюду
let dropped=0;
for(const key of ['byDateArt','byDateArtNet','byDateArtRub','byDateArtBuyRub']){
  const o={}; for(const [k,v] of Object.entries(M[key]||{})){ if(k.slice(11)===oldCode){dropped++;continue;} o[k]=v; } M[key]=o; }
delete (M.perArt||{})[oldCode]; delete (M.perArtNet||{})[oldCode];
console.log('удалено записей по старому артикулу: '+dropped);

// 2) добираем новый артикул из исходных файлов
const seen=new Set(); let added=0, addedQty=0; const newDates=new Set();
for(const f of files){
  const wb=load(f); const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:false,defval:''});
  const H=rows[0].map(x=>(''+x).replace(/^﻿/,'').trim());
  const iOtpr=H.indexOf('Номер отправления'),iAcc=H.indexOf('Принят в обработку'),iStatus=H.indexOf('Статус'),
        iArt=H.indexOf('Артикул'),iSku=H.indexOf('SKU'),iQty=H.indexOf('Количество'),iPrice=H.indexOf('Ваша цена');
  const ds=[]; for(let i=1;i<rows.length;i++){ if((''+(rows[i][iArt]||'')).trim()===newCode){const s=(''+(rows[i][iAcc]||'')).trim(); if(s)ds.push(s);} }
  if(!ds.length){ process.stderr.write('.'); continue; }
  const fmt=detectFmt(ds);
  for(let i=1;i<rows.length;i++){ const r=rows[i]; if((''+(r[iArt]||'')).trim()!==newCode) continue;
    const key=(''+(r[iOtpr]||''))+'|'+(''+(r[iSku]||'')); if(seen.has(key))continue; seen.add(key);
    const o=parts(r[iAcc],fmt); if(!o)continue; const d=iso(o); newDates.add(d);
    const q=num(r[iQty])||1, st=(''+(r[iStatus]||'')).trim(), rub=num(r[iPrice]);
    const k=d+'_'+newCode;
    M.byDateArt[k]=(M.byDateArt[k]||0)+q;
    M.byDateArtRub[k]=(M.byDateArtRub[k]||0)+rub;
    if(st==='Доставлен') M.byDateArtBuyRub[k]=(M.byDateArtBuyRub[k]||0)+rub;
    if(st!=='Отменён') M.byDateArtNet[k]=(M.byDateArtNet[k]||0)+q;
    added++; addedQty+=q;
  }
  process.stderr.write('+'+f.split('/').pop().slice(0,8)+'('+fmt+')');
}
// perArt пересобираем из по-дневных карт
M.perArt={}; for(const [k,v] of Object.entries(M.byDateArt)){ const a=k.slice(11); M.perArt[a]=(M.perArt[a]||0)+v; }
M.perArtNet={}; for(const [k,v] of Object.entries(M.byDateArtNet)){ const a=k.slice(11); M.perArtNet[a]=(M.perArtNet[a]||0)+v; }
M.builtAt=new Date().toISOString();
fs.writeFileSync(P,JSON.stringify(M));
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\nconst REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('\nдобавлено строк по новому артикулу '+newCode+': '+added+' ('+addedQty+' шт) · дней: '+newDates.size);
console.log('итого по '+newCode+' в своде: '+(M.perArt[newCode]||0)+' шт');
console.log('Дальше: node scripts/ozon-build.cjs --reuse <остатки.xlsx> <дата> && node scripts/encrypt.cjs <код>');
