// КИТАЙ, шаг 2 (ЗАП-21): из разобранных отчётов (parse.cjs) собирает вход для prod-plan.cjs — открытые заказы (дата на МП =
// срок изготовления + 2 мес), товар в пути (дата из прошлой загрузки, если была) и у поставщика; розница (H пустая) не входит.
// Пришедшее на свои склады после даты остатков «4 пер.» снимается с «в пути» (рост остатка 1С, свободный + резерв).
//   node scripts/china/build.cjs <папка> --date ГГГГ-ММ-ДД --stock-at ГГГГ-ММ-ДД
// Пишет <папка>/out/china/prod-plan-input.xlsx и build.json; копию снимка до загрузки — <папка>/bak-wb-data.js (для report.cjs).
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');const B=process.argv[2],ROOT=path.join(__dirname,'..','..');
const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:null;};
if(!B||!arg('--date')||!arg('--stock-at')){console.error('usage: node scripts/china/build.cjs <папка> --date ГГГГ-ММ-ДД --stock-at ГГГГ-ММ-ДД');process.exit(1);}
fs.mkdirSync(B+'/out/china',{recursive:true}); fs.copyFileSync(ROOT+'/decrypted/wb-data.js',B+'/bak-wb-data.js');
const X=require(ROOT+'/scripts/node_modules/xlsx');
const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync(ROOT+'/decrypted/wb-data.js','utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);const RD=ctx.__RD;
const prod=JSON.parse(fs.readFileSync(B+'/in-prod/rows.json','utf8'));const ved=JSON.parse(fs.readFileSync(B+'/in-ved/items.json','utf8'));
const TODAY=arg('--date'), STOCK_ISO=arg('--stock-at'), STOCK_AT=STOCK_ISO.slice(8,10)+'.'+STOCK_ISO.slice(5,7);
const iso=s=>{const m=String(s||'').match(/(\d\d)\.(\d\d)\.(\d{4})/);return m?m[3]+'-'+m[2]+'-'+m[1]:null};
const dmy=i=>i?i.slice(8,10)+'.'+i.slice(5,7)+'.'+i.slice(0,4):'';
const plus2m=i=>{const y=+i.slice(0,4),m=+i.slice(5,7)+2,d=i.slice(8,10);const yy=y+Math.floor((m-1)/12),mm=((m-1)%12)+1;return yy+'-'+String(mm).padStart(2,'0')+'-'+d;};
/* --mp "коды" — товар МП, хотя колонка H пустая: продавец исправил в 1С, а выгрузка ещё старая (18.11: 515286, 500182, 500171). */
const MPX=new Set(String(arg('--mp')||'').split(/[\s,;]+/).filter(Boolean));
ved.forEach(x=>{ if(MPX.has(x.code)&&!x.h){ x.h='RF/WB'; x.hFix='1С исправлен, выгрузка старая'; } });
if(MPX.size) fs.writeFileSync(B+'/in-ved/items.json',JSON.stringify(ved));
const V={};ved.forEach(x=>V[x.code]=x);
const pBy={};prod.forEach(r=>(pBy[r.code]=pBy[r.code]||[]).push(r));
const oBy={};RD.prodOrders.rows.forEach(r=>(oBy[r.sup]=oBy[r.sup]||[]).push(r));
const fac={};(RD.catalog||[]).forEach(c=>{const s=(''+(c.supplierCode||'')).trim();if(s&&c.factoryCode&&!fac[s])fac[s]=c.factoryCode;});
RD.prodOrders.rows.forEach(r=>{if(r.art&&!fac[r.sup])fac[r.sup]=r.art;});
const out=[], log={transitKeep:[],transitNoDate:[],supplierPending:[],supplierOverdue:[],supplierExtra:[],dateRisk:[],retail:[]};
// пришло на свои склады 18.11 (ведомость «4 пер.» — остатки на 17.11): рост остатка (свободный + резерв) 17.11 → 18.11
const H=RD.whHistory||{}; const tot=(d,c)=>{const h=H[d]||{};return (((h.bySup||{})[c]||{}).qty||0)+((((h.reserve||{})[c])||{}).qty||0);};
log.arrived18=[];
ved.filter(x=>x.h).forEach(x=>{
  const c=x.code, old=(oBy[c]||[]).slice(), open=(pBy[c]||[]);
  const HD=Object.keys(H).sort(), DNOW=HD[HD.length-1], DPREV=HD.filter(d=>d<=STOCK_ISO).pop();
  if(x.putK>0&&DPREV&&DNOW>DPREV){ const a=Math.max(0,tot(DNOW,c)-tot(DPREV,c)); if(a>0){ const t=a>=0.75*x.putK? x.putK : Math.min(a,x.putK);
    log.arrived18.push({code:c,name:x.name,qty:t,putK:x.putK}); x.putK-=t; } }
  const T=x.putK+x.putT, stage=x.putT&&x.putK?'в пути (до таможни '+x.putT+' + склад в пути Китай '+x.putK+')':x.putT?'в пути до таможни':'склад в пути Китай';
  // строки 27.10, которых нет среди открытых заказов 18.11 (ушли с фабрики)
  const openKey=new Set(open.map(r=>(iso(r.srok)||'')+'|'+r.qty));
  const gone=old.filter(r=>r.st!=='manual'&&!openKey.has((r.ready||'')+'|'+r.qty));
  if(T>0){
    let match=gone.find(r=>r.qty===T)|| (gone.length&&gone.reduce((a,r)=>a+r.qty,0)===T? null : null);
    let rowsT=[];
    if(match) rowsT=[{qty:T,ready:match.ready,mp:match.mp}];
    else if(gone.length&&gone.reduce((a,r)=>a+r.qty,0)===T) rowsT=gone.map(r=>({qty:r.qty,ready:r.ready,mp:r.mp}));
    else { const g=gone.slice().sort((a,b)=>(a.ready||'').localeCompare(b.ready||''));const mp=(g.find(r=>r.mp)||{}).mp||null;rowsT=[{qty:T,ready:(g[0]||{}).ready||null,mp,approx:true}]; }
    /* В пути без даты (или дата прошла) — дата остатков «4 пер.» + 2 мес (продавец 18.11.2026 на вопрос «через сколько попадает на МП
       товар в пути до таможни?» — «тоже два месяца»). */
    rowsT.forEach(t=>{ const keep=t.mp&&t.mp>=TODAY; const r={code:c,art:fac[c]||'',name:x.name,qty:t.qty,ready:t.ready,mpDate:keep?t.mp:plus2m(STOCK_ISO),
        mpText:'',kind:'transit',stage,est:!keep};
      out.push(r); (r.est?log.transitNoDate:log.transitKeep).push(r); });
  }
  // у поставщика: открытые заказы
  let openSum=0;
  open.forEach(p=>{ const rd=iso(p.srok); openSum+=p.qty; const mp=rd?plus2m(rd):null;
    const r={code:c,art:fac[c]||'',name:x.name,qty:p.qty,ready:rd,mpDate:mp&&mp>=TODAY?mp:null,
      mpText:mp&&mp>=TODAY?'':(rd?'у поставщика в Китае по 1С на '+STOCK_AT+', срок изготовления '+dmy(rd)+' прошёл':'у поставщика в Китае, срок изготовления не указан (заказ '+p.ord+' от '+dmy(p.ordDate)+')'),
      kind:'supplier',ord:p.ord,ordDate:p.ordDate};
    out.push(r); (r.mpDate?log.supplierPending:log.supplierOverdue).push(r);
    if(r.mpDate&&rd&&rd<STOCK_ISO) log.dateRisk.push(r); /* срок изготовления прошёл, а товар ещё у поставщика — дата под вопросом */ });
  if(x.sklK>openSum+0.5){ const extra=x.sklK-openSum; const g=old.slice().sort((a,b)=>(b.ready||'').localeCompare(a.ready||''))[0]||{};
    const r={code:c,art:fac[c]||'',name:x.name,qty:extra,ready:g.ready||null,mpDate:null,mpText:'на складе поставщика в Китае по 1С на '+STOCK_AT+' (открытого заказа нет)',kind:'extra'};
    out.push(r); log.supplierExtra.push(r); }
});
// розница в файлах (для отчёта)
ved.filter(x=>!x.h&&(oBy[x.code]||pBy[x.code])).forEach(x=>log.retail.push({code:x.code,name:x.name,old:(oBy[x.code]||[]).reduce((a,r)=>a+r.qty,0),open:(pBy[x.code]||[]).reduce((a,r)=>a+r.qty,0),pipe:x.putK+x.putT+x.sklK,ost:x.ost}));
// файл для prod-plan
const aoa=[['Код','Артикул','Номенклатура','Общее количество в штуках','Срок готовности товара','Срок приезда на маркетплейс']];
out.forEach(r=>aoa.push([r.code,r.art,r.name,r.qty,r.ready?dmy(r.ready):'',r.mpDate?dmy(r.mpDate):r.mpText]));
const wb=X.utils.book_new();X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet(aoa),'Заказы');X.writeFile(wb,B+'/out/china/prod-plan-input.xlsx');
fs.writeFileSync(B+'/out/china/build.json',JSON.stringify({out,log}));
const S=a=>a.reduce((s,r)=>s+r.qty,0);
console.log('пришло 18.11 (снято с «в пути»):',log.arrived18.map(a=>a.code+' '+a.qty).join(', '),'=',log.arrived18.reduce((s,a)=>s+a.qty,0),'шт');
console.log('строк',out.length,'кодов',new Set(out.map(r=>r.code)).size,'шт',S(out));
console.log('в пути, дата из прошлой загрузки:',log.transitKeep.length,'строк',S(log.transitKeep),'шт');
console.log('в пути без своей даты → '+plus2m(STOCK_ISO)+' (дата остатков + 2 мес):',log.transitNoDate.length,'строк',S(log.transitNoDate),'шт');
console.log('у поставщика, дата на МП впереди (изготовление + 2 мес):',log.supplierPending.length,'строк',S(log.supplierPending),'шт');
console.log('у поставщика, срок прошёл / не указан:',log.supplierOverdue.length,'строк',S(log.supplierOverdue),'шт');
console.log('у поставщика без открытого заказа:',log.supplierExtra.length,'строк',S(log.supplierExtra),'шт');
console.log('по датам на МП:',JSON.stringify(out.filter(r=>r.mpDate).reduce((m,r)=>{m[r.mpDate]=(m[r.mpDate]||0)+r.qty;return m},{})));
console.log('\nРИСК ДАТЫ — у поставщика, а на МП должно быть до 31.12:',log.dateRisk.length,'строк',S(log.dateRisk),'шт; коды:',[...new Set(log.dateRisk.map(r=>r.code))].join(' '));
console.log('\nРОЗНИЦА (колонка H пустая), была в заказах:');log.retail.forEach(r=>console.log('   ',r.code,'27.10:',r.old,'| открыто 18.11:',r.open,'| труба',r.pipe,'| ост',r.ost,'|',r.name.slice(0,50)));
