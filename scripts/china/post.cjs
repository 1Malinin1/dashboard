// КИТАЙ, шаг 4 (ЗАП-21) — после prod-plan.cjs: вся труба по 1С на дату «4 пер.» ещё не пришла → since = дата загрузки, прошлые партии
// (`missAt`) = весь остаток заказа, стадия (в пути / у поставщика) — в строки, снимок трубы — `prodOrders.pipe1c`; пересчёт прихода.
//   node scripts/china/post.cjs <папка> --date ГГГГ-ММ-ДД --stock-at ГГГГ-ММ-ДД
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');const B=process.argv[2],ROOT=path.join(__dirname,'..','..'),F=ROOT+'/decrypted/wb-data.js';
const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:null;};
if(!B||!arg('--date')||!arg('--stock-at')){console.error('usage: node scripts/china/post.cjs <папка> --date ГГГГ-ММ-ДД --stock-at ГГГГ-ММ-ДД');process.exit(1);}
const src=fs.readFileSync(F,'utf8');const ctx={};vm.createContext(ctx);vm.runInContext(src+'\nglobalThis.__RD=REAL_DATA;',ctx);const RD=ctx.__RD;
const ARR=require(ROOT+'/scripts/lib/prod-arrivals.cjs');
const {out}=JSON.parse(fs.readFileSync(B+'/out/china/build.json','utf8'));
const ved=JSON.parse(fs.readFileSync(B+'/in-ved/items.json','utf8'));
const P=RD.prodOrders, D=arg('--date'), SA=arg('--stock-at'), SAd=SA.slice(8,10)+'.'+SA.slice(5,7);
const pool={};out.forEach(r=>{const k=r.code+'|'+(r.ready||'')+'|'+r.qty;(pool[k]=pool[k]||[]).push(r);});
let st={};P.rows.forEach(r=>{ if(r.st==='manual') return; r.since=D;
  const k=r.sup+'|'+(r.ready||'')+'|'+r.qty; const m=(pool[k]||[]).shift(); if(m){ r.stage=m.kind==='transit'? (m.stage||'в пути') : m.kind==='extra'? 'у поставщика (без заказа)' : 'у поставщика'; if(m.ord) r.ord=m.ord; }
  st[r.stage||'?']=(st[r.stage||'?']||0)+r.qty; });
const by={};P.rows.filter(r=>r.st==='overdue').forEach(r=>(by[r.sup]=by[r.sup]||[]).push(r));
P.missAt={};Object.entries(by).forEach(([s,rs])=>{const ord=rs.reduce((a,r)=>a+r.qty,0),ready=rs.map(r=>r.ready||'9999').sort()[0];
  P.missAt[s]={ord,ready:ready<'9999'?ready:null,qty:ord,since:D,src:'1С «4 пер.» на '+SAd+': в пути / у поставщика'};});
P.pipe1c={date:SA,src:'ведомость «4 пер. 2026» (колонка H — направление)',loadedAt:D,bySup:{}};
ved.filter(x=>x.h).forEach(x=>{ if(x.putK||x.putT||x.sklK) P.pipe1c.bySup[x.code]={dir:x.h,putK:x.putK,putT:x.putT,sklK:x.sklK}; });
P.note='С '+D+': открытые заказы — «Заказы поставщику» 1С (дата на МП = срок изготовления + 2 мес), товар в пути и у поставщика — ведомость «4 пер.» на '+SAd+'; розница (колонка H пустая) не входит';
const log=ARR.computeArrivals(RD);
fs.writeFileSync(F,src.slice(0,src.indexOf('const REAL_DATA'))+'const REAL_DATA = '+JSON.stringify(RD)+';\n');
const S=a=>a.reduce((s,r)=>s+r.qty,0);
console.log('стадии строк:',JSON.stringify(st));
console.log('прошлые партии (ждём без срока):',Object.keys(P.missAt).length,'кодов',Object.values(P.missAt).reduce((a,m)=>a+m.qty,0),'шт');
console.log('приход после 18.11:',log.length,'событий; inbound:',Object.entries(RD.inbound).map(([k,v])=>k+' '+v.total).join(' · '));
console.log('труба 1С сохранена:',Object.keys(P.pipe1c.bySup).length,'кодов');
