// НЕЗАВИСИМАЯ ПРОВЕРКА ФАЙЛОВ ПЛАНА ЗАКАЗОВ ДЛЯ РЕПРАЙСЕРА (ЗАП-24, 18.11.2026).
// Зачем: 18.11 в файлы ушло «1 вместо 21» (Ozon 487199) из-за ошибочного правила — продавец: «я собираюсь работать с тем, что ты мне
// округляешь». Перед отдачей файлов прогонять ЭТО: свой расчёт формулы ЗАП-24 по каждой строке (не код сайта) + сверка входов
// сайта с сырыми данными снимка (заказы ВБ/Ozon за 7 дн, остаток ВБ, отгрузки в пути, свои склады, партии) + пропуски.
//   VERIFY_CODE=… node scripts/repricer-plan-check.cjs <готовый файл ВБ> <готовый файл Ozon>
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');const ROOT=path.join(__dirname,'..');
const X=require('./node_modules/xlsx');const { withDashboardBrowser, unlockDashboard } = require('./lib/dashboard-browser.cjs');
const [FW,FO]=process.argv.slice(2), CODE=process.env.VERIFY_CODE, PORT=+(process.env.PORT||8796);
if(!FW||!FO||!CODE){ console.error('usage: VERIFY_CODE=… node scripts/repricer-plan-check.cjs <файл ВБ> <файл Ozon>'); process.exit(1); }
async function dump(){
  return withDashboardBrowser(PORT, async (b, url) => {
    const p=await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    await p.goto(url,{waitUntil:'load'}); await unlockDashboard(p, CODE);
    await p.waitForFunction(()=>typeof FINANCE_CACHE!=='undefined'&&FINANCE_CACHE.length>0&&typeof srRows==='function'&&OZDATA,null,{timeout:120000});
    const d=await p.evaluate(()=>({rows:srExtend(srDecorate(srRows())).map(r=>({sup:r.sup,stockWb:r.stockWb,wbTr:r.wbTr,wbShip:r.wbShip,whQty:r.whQty,
      whMsk:r.whMsk,whNsk1:r.whNsk1,whNsk2:r.whNsk2,whKlin:r.whKlin,whOther:r.whOther,stockOz:r.stockOz,spdWb:r.spdWb,spdOz:r.spdOz,ordWb:r.ordWb,ordOz:r.ordOz,
      boWb:r.boWb,supplies:r.supplies||[],hz:r.hz,target:r.target,targetOrders:r.targetOrders,planRep:r.planRep,verdict:r.verdict,total:r.total})),
      share:PROD_MP_SHARE,H:PLAN_HZ,bo:(RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutWin)||null}));
    if(errs.length) throw new Error('ошибки на сайте: '+errs.join(' | '));
    return d;
  });
}
(async()=>{
const D=await dump();
const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(ROOT,'decrypted','wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);const RD=ctx.__RD;
const Resupply=require(path.join(ROOT,'calc','resupply.js'));const whKey=Resupply.whKey;
const by={};D.rows.forEach(r=>by[r.sup]=r);const SH=D.share,H=D.H;
const T=new Date().toISOString().slice(0,10),dl=i=>Math.round((new Date(i+'T00:00:00Z')-new Date(T+'T00:00:00Z'))/864e5);
// --- сырые входы
const wbStock={},cards={};RD.catalog.forEach(c=>{const s=(''+(c.supplierCode||'')).trim();if(!s)return;wbStock[s]=(wbStock[s]||0)+(c.wbStock||0);(cards[s]=cards[s]||[]).push(''+c.sku);});
const ship={};(RD.shipments||[]).forEach(x=>{if(x.mp==='wb'&&x.left>0)ship[x.sup]=(ship[x.sup]||0)+x.left;});
const own=s=>{const q={msk:0,nsk1:0,nsk2:0,klin:0,other:0,retail:0,ozsfo:0,ozcfo:0};Object.entries(((RD.warehouse.bySup||{})[s]||{}).wh||{}).forEach(([n,v])=>{q[whKey(n)]=(q[whKey(n)]||0)+v;});return q;};
const W=RD.orderSeries,nW=W.dates.length;const ordWbRaw=s=>{let q=0;(cards[s]||[]).forEach(k=>{const v=W.bySku[k]||[];for(let i=nW-7;i<nW;i++)q+=v[i]||0;});return q/7;};
const O=RD.ozon.orderSeries,nO=O.dates.length;const ordOzRaw=s=>{const v=O.byArt[s]||[];let q=0;for(let i=nO-7;i<nO;i++)q+=v[i]||0;return q/7;};
const bat=s=>RD.prodOrders.rows.filter(x=>x.sup===s&&x.mp&&(x.st==='pending'||x.st==='manual')).map(x=>({t:dl(x.mp),q:x.done?0:Math.max(0,x.qty-(x.got||0))})).filter(x=>x.q>0&&x.t>0);
// --- новинка на площадке (ЗАП-27/28, 20.11.2026): заказов на ЭТОЙ площадке не было или первый — не раньше 30 дн до последнего дня её ряда → план не ниже 15
const fW={},fO={};Object.entries(cards).forEach(([s,ks])=>ks.forEach(k=>{const v=W.bySku[k]||[];const i=v.findIndex(x=>x>0);if(i>=0&&(!fW[s]||W.dates[i]<fW[s]))fW[s]=W.dates[i];}));
Object.entries(O.byArt).forEach(([s,v])=>{const i=v.findIndex(x=>x>0);if(i>=0&&(!fO[s]||O.dates[i]<fO[s]))fO[s]=O.dates[i];});
const cutOf=S=>new Date(Date.parse(S.dates[S.dates.length-1]+'T00:00:00Z')-30*864e5).toISOString().slice(0,10);const cW=cutOf(W),cO=cutOf(O);
const isNewRaw=(s,mp)=>mp==='oz'? (!fO[s]||fO[s]>=cO) : (!fW[s]||fW[s]>=cW);
const floorNew=(s,p,r,mp)=>r&&isNewRaw(s,mp)&&p.J<15? {J:15,why:'новинка — старт 15'} : p;
// --- своя формула
const planWb=r=>{ if(!r) return {J:10,why:'нет в данных'}; const wbBase=r.stockWb+r.wbTr+r.whQty, reach=r.whMsk+r.whNsk1+r.whNsk2+r.whKlin, ozOwn=r.stockOz;
  if(!(r.total>0||r.spdWb+r.spdOz>0)) return {J:10,why:'нет ни товара, ни продаж'};
  if(wbBase<=0) return {J:10,why:'нет товара для ВБ'};
  const sup=bat(r.sup).filter(x=>x.t<=H).sort((a,b)=>a.t-b.t);
  const av=(t,inc)=>Math.max(0,wbBase+inc*SH-Math.max(0,Math.min(r.spdOz*t-ozOwn,reach+inc*SH)));
  let cum=0,best=Infinity;sup.forEach(x=>{best=Math.min(best,av(x.t,cum)/x.t);cum+=x.q;});best=Math.min(best,av(H,cum)/H);
  return {J:Math.max(1,Math.round(best/r.boWb)),raw:best/r.boWb}; };
const planOz=(r,bo)=>{ if(!r) return {J:10,why:'нет в данных'}; const wbOwn=r.stockWb+r.wbTr; const sup=bat(r.sup).filter(x=>x.t<=H).sort((a,b)=>a.t-b.t);
  if(r.stockOz+r.whQty+sup.reduce((a,x)=>a+x.q,0)<=0 || r.stockOz+r.whQty<=0) return {J:10,why:'нет товара'};   // как nostock у ВБ (19.11)
  const base=(t,inc)=>r.stockOz+r.whQty+inc*SH;   // ЗАП-26: приоритет Ozon — ВБ не вычитаем
  let cum=0,best=Infinity;sup.forEach(x=>{best=Math.min(best,base(x.t,cum)/x.t);cum+=x.q;});best=Math.min(best,base(H,cum)/H);
  return {J:Math.max(1,Math.round(best/bo)),raw:best/bo}; };
// --- файлы
const read=f=>{const wb=X.readFile(f);return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:''});};
const fw=read(FW), fo=read(FO);
const ozBo={};D.rows.forEach(r=>{ if(r.ordOz>0&&r.spdOz>0) ozBo[r.sup]=r.spdOz/r.ordOz; });const boH=(D.bo&&D.bo.history)||[], boL=boH[boH.length-1]||{};Object.entries(boL.bySku||{}).forEach(([s,v])=>{ if(ozBo[s]==null) ozBo[s]=v; });
const iW=fw[0].findIndex(h=>/OrdersPlanQty/.test(h)), iS=fw[0].findIndex(h=>/SupplierArticle/.test(h));
const iO=fo[0].findIndex(h=>/OrdersPlanQty/.test(h)), iOf=fo[0].findIndex(h=>/OfferId/.test(h));
const out={wbRows:0,wbBad:[],ozRows:0,ozBad:[],inBad:[],gaps:[],one:[]};
fw.slice(1).forEach(row=>{const s=String(row[iS]);if(!s)return;out.wbRows++;const r=by[s];const p=floorNew(s,planWb(r),r,'wb');if(p.J!==row[iW])out.wbBad.push(s+': файл '+row[iW]+', проверка '+p.J+(p.why?' ('+p.why+')':' (до окр. '+(Math.round(p.raw*100)/100)+')'));
  if(!r&&((wbStock[s]||0)>0||(((RD.warehouse.bySup||{})[s]||{}).qty||0)>0))out.gaps.push('ВБ '+s+': в файле «нет данных», а товар есть (ВБ '+(wbStock[s]||0)+', свой склад '+((((RD.warehouse.bySup||{})[s]||{}).qty)||0)+')');
  if(row[iW]===1&&r){const stock=r.stockWb+r.wbTr+r.whQty;out.one.push(s+' ВБ: товара для ВБ '+stock+' шт, заказов '+(Math.round(r.ordWb*10)/10)+'/дн');}});
const ourOz=new Set(((RD.ozon||{}).catalog||[]).map(c=>''+c.sku));
fo.slice(1).forEach(row=>{const s=String(row[iOf]);if(!ourOz.has(s)||row[iO]==='')return;out.ozRows++;const r=by[s];const p=floorNew(s,planOz(r,ozBo[s]||boL.all||0.8),r,'oz');if(p.J!==row[iO])out.ozBad.push(s+': файл '+row[iO]+', проверка '+p.J+(p.why?' ('+p.why+')':' (до окр. '+(Math.round(p.raw*100)/100)+')'));});
// входы против сырых данных
D.rows.forEach(r=>{const s=r.sup;const e=[];
  if(Math.abs((r.ordWb||0)-ordWbRaw(s))>0.01)e.push('заказы ВБ/дн сайт '+r.ordWb+' ≠ ряд '+ordWbRaw(s));
  if(Math.abs((r.ordOz||0)-ordOzRaw(s))>0.01)e.push('заказы Ozon/дн сайт '+r.ordOz+' ≠ ряд '+ordOzRaw(s));
  if(Math.abs((r.stockWb||0)-(wbStock[s]||0))>0.5)e.push('остаток ВБ сайт '+r.stockWb+' ≠ каталог '+(wbStock[s]||0));
  if(Math.abs((r.wbTr||0)-(ship[s]||0))>0.5)e.push('в пути на ВБ сайт '+r.wbTr+' ≠ журнал '+(ship[s]||0));
  const q=own(s), wq=q.msk+q.nsk1+q.nsk2+q.klin+q.other;if(Math.abs((r.whQty||0)-wq)>0.5)e.push('свои склады сайт '+r.whQty+' ≠ ведомость '+wq);
  const bs=bat(s).map(x=>x.t+':'+x.q).sort().join(','), ss=(r.supplies||[]).filter(x=>x.t>0).map(x=>x.t+':'+x.q).sort().join(',');if(bs!==ss)e.push('партии сайт ['+ss+'] ≠ файл заказов ['+bs+']');
  if(e.length)out.inBad.push(s+': '+e.join('; '));});
// наши коды Ozon с товаром, которых нет в файле Ozon
const inOz=new Set(fo.slice(1).map(r=>String(r[iOf])));((RD.ozon||{}).catalog||[]).forEach(c=>{const s=''+c.sku;const r=by[s];if(((c.ozStock||0)+(c.ozTransit||0))>0&&!inOz.has(s))out.gaps.push('Ozon '+s+': товар на Ozon есть, а строки в выгрузке Indeepa нет');});
console.log('ВБ: строк',out.wbRows,'| расхождений файла с независимым расчётом:',out.wbBad.length);out.wbBad.slice(0,20).forEach(x=>console.log('   ',x));
console.log('Ozon: наших строк',out.ozRows,'| расхождений:',out.ozBad.length);out.ozBad.slice(0,20).forEach(x=>console.log('   ',x));
console.log('ВХОДЫ (сайт против сырых данных): кодов с расхождением',out.inBad.length);out.inBad.slice(0,25).forEach(x=>console.log('   ',x));
console.log('ПРОПУСКИ:',out.gaps.length);out.gaps.slice(0,25).forEach(x=>console.log('   ',x));
const bad=out.wbBad.length+out.ozBad.length+out.inBad.length+out.gaps.length;
console.log(bad? '\n⚠ ЕСТЬ РАСХОЖДЕНИЯ — файлы продавцу не отдавать, пока не разобраны' : '\n✓ Файлы сходятся с независимым расчётом, входы — с данными снимка.');
process.exitCode=bad?1:0;
})().catch(e=>{ console.error(e.message||e); process.exit(1); });
