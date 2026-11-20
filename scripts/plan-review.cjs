// ЕЖЕНЕДЕЛЬНЫЙ РАЗБОР ПЛАНА ЗАКАЗОВ ДЛЯ РЕПРАЙСЕРА — ГИПОТЕЗА Г-01 (ЗАП-25, с 18.11.2026).
//
// Продавец 18.11.2026: «теперь раз в неделю мы будем редактировать план заказов в зависимости от того, как у нас пойдёт план.
// Запиши этот план и пометь это как гипотезу, далее если где-то будут нужны корректировки — будешь каждый пн говорить, где нужно
// поменять и почему, и потом я буду обновлять такие файлы. Как рекламой ты говоришь мне — так же и тут».
// Отданный план лежит в `meta.planSet` {date, wb:{код:план}, oz:{код:план}, base:{входы на день плана}} (пишет repricer-plan.cjs-цепочка
// и этот скрипт с --init). Каждый понедельник: этот разбор → продавцу «где поменять и почему» по ВБ и по Ozon → он обновляет файлы
// Indeepa → новые файлы считает repricer-plan.cjs, проверяет repricer-plan-check.cjs, планы снова в `meta.planSet`.
//
//   VERIFY_CODE=… node scripts/plan-review.cjs           разбор: план против факта с даты плана + пересчёт по ЗАП-24 на сегодня
//   VERIFY_CODE=… node scripts/plan-review.cjs --init    записать входы на день плана (запас, партии, темп) в meta.planSet.base
//
// ЧТО СЧИТАЕТСЯ ПОВОДОМ ПОМЕНЯТЬ ПЛАН (ЗАП-25): пересчёт по ЗАП-24 на сегодня отличается от стоящего плана на ≥ 25% и ≥ 2 заказа —
// причина печатается: изменился запас (пришла/уехала партия, продали быстрее), новые партии, темп продаж. Отдельно, БЕЗ смены
// плана (решает продавец): «упёрлись в минимальную цену» (заказов < 75% плана 3+ дня, цена у минимальной — план недостижим на
// минимуме, рычаг — реклама) и «упёрлись в базовую» (заказов > 125% плана, цена у базовой — кончится раньше 180 дней).
'use strict';
const fs=require('fs'), vm=require('vm'), path=require('path'), cp=require('child_process');
const { chromium }=require('./node_modules/playwright-core');
const { planOz }=require('./lib/plan-oz.cjs');
const ROOT=path.join(__dirname,'..'), OUT=path.join(ROOT,'decrypted'), F=path.join(OUT,'wb-data.js');
const CODE=process.env.VERIFY_CODE, INIT=process.argv.includes('--init'), PORT=+(process.env.PORT||8797);
if(!CODE){ console.error('usage: VERIFY_CODE=… node scripts/plan-review.cjs [--init]'); process.exit(1); }
const src=fs.readFileSync(F,'utf8'); const ctx={}; vm.createContext(ctx); vm.runInContext(src+'\nglobalThis.__RD=REAL_DATA;',ctx); const RD=ctx.__RD;
const PS=RD.meta&&RD.meta.planSet; if(!PS){ console.error('нет meta.planSet — план ещё не отдавался (repricer-plan.cjs)'); process.exit(1); }
const f1=v=>v==null? '—' : (Math.round(v*10)/10).toString().replace('.',','), F0=n=>Math.round(n||0).toLocaleString('ru-RU');

async function dump(){
  const srv=cp.spawn('python3',['-m','http.server',String(PORT),'--bind','127.0.0.1'],{cwd:ROOT,stdio:'ignore'});
  await new Promise(r=>setTimeout(r,800));
  const b=await chromium.launch({executablePath:(process.env.PW_CHROME||'/opt/pw-browsers/chromium'),args:['--no-sandbox']});
  try{ const p=await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    await p.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'load'}); await p.fill('#lockInput',CODE); await p.click('.lock-btn');
    await p.waitForFunction(()=>typeof FINANCE_CACHE!=='undefined'&&FINANCE_CACHE.length>0&&typeof srRows==='function'&&OZDATA,null,{timeout:120000});
    const d=await p.evaluate(()=>({rows:srExtend(srDecorate(srRows())).map(r=>({sup:r.sup,name:r.name,stockWb:r.stockWb||0,wbTr:r.wbTr||0,wbShip:r.wbShip||0,
      whQty:r.whQty||0,stockOz:r.stockOz||0,spdWb:r.spdWb||0,spdOz:r.spdOz||0,ordWb:r.ordWb||0,ordOz:r.ordOz||0,supplies:r.supplies||[],planRep:r.planRep,
      tgtSrc:r.tgtSrc||'',isNew:!!r.isNew,isNewOz:!!r.isNewOz})), share:PROD_MP_SHARE, H:PLAN_HZ, bo:(RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutWin)||null}));
    if(errs.length) throw new Error('ошибки на сайте: '+errs.join(' | '));
    return d;
  } finally { await b.close(); srv.kill(); } }

(async()=>{
  const D=await dump(); const by={}; D.rows.forEach(r=>by[r.sup]=r);
  const hist=(D.bo&&D.bo.history)||[], lb=hist[hist.length-1]||{};
  const ozPlanNow=r=>{ const J=planOz(r,{share:D.share,H:D.H,bo:(r.ordOz>0&&r.spdOz>0)? r.spdOz/r.ordOz : ((lb.bySku||{})[r.sup]||lb.all||0.8),nodata:10}).J;
    return r.isNewOz? Math.max(15,J) : J; };   // ЗАП-27/28: новинка на Ozon — не ниже 15
  const sumSup=r=>(r.supplies||[]).reduce((a,x)=>a+(x.q||0),0);
  if(INIT){
    PS.base={}; Object.keys(Object.assign({},PS.wb,PS.oz)).forEach(c=>{ const r=by[c]; if(!r) return;
      PS.base[c]={wbStock:r.stockWb+r.wbTr+r.whQty, ozStock:r.stockOz+r.whQty, sup:sumSup(r), spdWb:Math.round(r.spdWb*100)/100, spdOz:Math.round(r.spdOz*100)/100}; });
    PS.baseAt=new Date().toISOString().slice(0,10);
    fs.writeFileSync(F,src.slice(0,src.indexOf('const REAL_DATA'))+'const REAL_DATA = '+JSON.stringify(RD)+';\n');
    console.log('Входы на день плана записаны: кодов '+Object.keys(PS.base).length+' (meta.planSet.base, '+PS.baseAt+'). Дальше: node scripts/encrypt.cjs <код>'); return;
  }
  const D0=PS.date, base=PS.base||{};
  const pc=(RD.meta&&RD.meta.priceChanges)||{}, pk=Object.keys(pc).sort(), last=pc[pk[pk.length-1]]||{};
  const corW=(last.wb&&last.wb.byCode)||{}, corO=(last.oz&&last.oz.byCode)||{};
  const cards={}; (RD.catalog||[]).forEach(c=>{ const s=(''+(c.supplierCode||'')).trim(); if(s) (cards[s]=cards[s]||[]).push(''+c.sku); });
  const seg=(S,keys,from,to)=>{ let q=0,rub=0,n=0; S.dates.forEach((d,i)=>{ if(d<from||d>to) return; n++; keys.forEach(k=>{ const v=(S.bySku||S.byArt)[k]; q+=(v&&v[i])||0;
    const m=S.money&&S.money[k]; const mm=m&&m[i]; rub+=Array.isArray(mm)? (mm[0]||0) : (mm||0); }); }); return {q,rub,n}; };
  const addD=(iso,k)=>{ const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+k); return d.toISOString().slice(0,10); };
  const why=(c,mp,r)=>{ const b=base[c]; if(!b||!r) return 'пересчёт по ЗАП-24 на сегодня';
    const st=mp==='wb'? r.stockWb+r.wbTr+r.whQty : r.stockOz+r.whQty, st0=mp==='wb'? b.wbStock : b.ozStock, sp=mp==='wb'? r.spdWb : r.spdOz, sp0=mp==='wb'? b.spdWb : b.spdOz;
    const w=[]; if(Math.abs(st-st0)>=Math.max(20,0.1*st0)) w.push('запас '+F0(st0)+' → '+F0(st)+' шт');
    const su=sumSup(r); if(Math.abs(su-(b.sup||0))>=Math.max(20,0.1*(b.sup||1))) w.push('партии '+F0(b.sup)+' → '+F0(su)+' шт');
    if(Math.abs(sp-sp0)>=Math.max(1,0.25*sp0)) w.push('продажи '+f1(sp0)+' → '+f1(sp)+'/дн'); return w.join(', ')||'пересчёт по ЗАП-24 на сегодня'; };
  const review=(mp)=>{
    const S= mp==='wb'? RD.orderSeries : RD.ozon.orderSeries, plans= mp==='wb'? PS.wb : PS.oz, cor= mp==='wb'? corW : corO;
    const lastD=S.dates[S.dates.length-1], from=addD(D0,1), nAfter=S.dates.filter(d=>d>=from&&d<=lastD).length;
    const res={change:[],atMin:[],atBase:[],inPlan:0,below:0,above:0,nAfter,from,lastD};
    Object.entries(plans).forEach(([c,P])=>{ const r=by[c]; const keys= mp==='wb'? (cards[c]||[]) : [c];
      const now= mp==='wb'? (r&&r.planRep!=null? r.planRep : 10) : (r? ozPlanNow(r) : 10);
      if(Math.abs(now-P)>=Math.max(2,0.25*P)) res.change.push({c,P,now,why:why(c,mp,r),name:(r&&r.name)||''});
      if(nAfter<=0) return;
      const a=seg(S,keys,from,lastD), q=a.q/nAfter; const k=q/P; if(k<0.75) res.below++; else if(k>1.25) res.above++; else res.inPlan++;
      const pr=a.q? a.rub/a.q : null, cc=cor[c]||{}, mn= mp==='wb'? cc.new&&cc.new.MinPrice : cc.min, bs= mp==='wb'? cc.new&&cc.new.MaxPrice : cc.base;
      if(nAfter>=3 && pr && mn && k<0.75 && pr<=mn*1.03) res.atMin.push({c,P,q,pr,mn,name:(r&&r.name)||''});
      if(nAfter>=3 && pr && bs && k>1.25 && pr>=bs*0.97) res.atBase.push({c,P,q,pr,bs,name:(r&&r.name)||''}); });
    return res; };
  console.log('РАЗБОР ПЛАНА ЗАКАЗОВ (гипотеза Г-01, ЗАП-25): план отдан '+D0+(base&&PS.baseAt? ' · входы на день плана — '+PS.baseAt : ' · входов на день плана нет (--init)'));
  [['wb','ВБ'],['oz','Ozon']].forEach(([mp,L])=>{ const R=review(mp);
    console.log('\n═══ '+L+' ═══ факт после плана: '+(R.nAfter? R.from+'…'+R.lastD+' ('+R.nAfter+' дн)' : 'данных ещё нет')
      +(R.nAfter? ' · в плане (75–125%) '+R.inPlan+' · ниже '+R.below+' · выше '+R.above : ''));
    console.log('  ГДЕ ПОМЕНЯТЬ ПЛАН ('+R.change.length+'): пересчёт по ЗАП-24 на сегодня отличается от стоящего на ≥ 25% и ≥ 2 заказа');
    R.change.sort((a,b)=>Math.abs(b.now-b.P)-Math.abs(a.now-a.P)).slice(0,40).forEach(x=>console.log('     '+x.c+': '+x.P+' → '+x.now+' — '+x.why+' · '+String(x.name).slice(0,32)));
    if(R.atMin.length){ console.log('  УПЁРЛИСЬ В МИНИМАЛЬНУЮ ЦЕНУ (план недостижим на минимуме — план не трогаем, рычаг реклама; решает продавец): '+R.atMin.length);
      R.atMin.slice(0,20).forEach(x=>console.log('     '+x.c+': план '+x.P+', заказов '+f1(x.q)+'/дн, цена '+F0(x.pr)+' при минимальной '+F0(x.mn))); }
    if(R.atBase.length){ console.log('  УПЁРЛИСЬ В БАЗОВУЮ (уходит быстрее плана даже на базовой — кончится раньше 180 дн; решает продавец): '+R.atBase.length);
      R.atBase.slice(0,20).forEach(x=>console.log('     '+x.c+': план '+x.P+', заказов '+f1(x.q)+'/дн, цена '+F0(x.pr)+' при базовой '+F0(x.bs))); } });
  console.log('\nДальше: продавцу — «где поменять и почему» по ВБ и Ozon; он присылает свежие выгрузки Indeepa → repricer-plan.cjs → repricer-plan-check.cjs.');
})().catch(e=>{ console.error(e.message||e); process.exit(1); });
