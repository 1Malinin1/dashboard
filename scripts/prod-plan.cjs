// ЗАКАЗЫ НА ПРОИЗВОДСТВО — ВЕСЬ ФАЙЛ ПРОДАВЦА ЦЕЛИКОМ (с 27.10.2026; правило ЗАП-15 в ПРАВИЛА.md).
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. Раньше партии заводились по одной (`prod-order.cjs`: одна партия —
// один ключ `inbound.orderN`), а коды без партии шли по «общей дате» или ручному сроку
// (`meta.etaOverride`). 27.10.2026 продавец прислал ФАЙЛ ВСЕХ ЗАКАЗОВ на производство и сказал:
// «всё, что было до этого момента, можешь удалить — там информация будет неактуальная, для
// последующей работы берёшь только эти данные». Поэтому этот скрипт ЗАМЕНЯЕТ партии целиком:
// стирает прежние `inbound.*` (кроме `china`) и `meta.etaOverride`, кладёт все строки файла в
// `RD.prodOrders.rows` и из ИДУЩИХ партий собирает `inbound.p<ГГГГММДД>` по дате приезда на МП —
// их читают «Запас и темп», «Разбор товара», «Закуп» и подсорт («Приедет»).
//
// ФОРМАТ ФАЙЛА (колонки ищутся ПО ИМЕНИ): Код (код 1С) · Артикул (= КОД ФАБРИКИ) · Номенклатура ·
// Общее количество в штуках · Срок готовности товара (на фабрике) · Срок приезда на маркетплейс —
// дата ИЛИ текст «Товар должен был уже придти… сроков точных нету».
//   · Дата приезда РАНЬШЕ даты готовности — опечатка в годе, +1 год (продавец 27.10: «15.01.2026»
//     у готовности 15.11.2026 — «правильный вариант 15.01.2027»).
//   · Год готовности дальше следующего (2028/2030/2034 у строк «должен был уже придти») — опечатка,
//     ставим текущий год; скрипт печатает такие строки.
// СТАТУСЫ СТРОК: `pending` — едет, есть дата приезда на МП; `overdue` — «должен был уже придти»:
// по правилу продавца 27.10 (ответ «а») такая партия, если её не видно ни в остатке, ни в продажах,
// «должна была прийти, её нет, ждём без срока» и В ЗАПАС НЕ СЧИТАЕТСЯ — в `inbound` её нет;
// `manual` — заказ, которого нет в файле (продавец сказал словами), заводится `add`.
// КОД ФАБРИКИ: колонка «Артикул» пишется в `catalog[].factoryCode`: где пусто — дописывается («нужно просто
// добавить недостающие»), где отличается не только регистром — ЗАМЕНЯЕТСЯ значением файла (продавец 27.10.2026
// про 9 расхождений: «бери согласно файлу»). Русские буквы-двойники в латинском коде («658Т blue» с русской Т)
// меняются на латинские — иначе код не находится поиском; скрипт печатает такие строки.
// НОВЫЕ КОДЫ (`--new-codes`): коды файла, которых нет ни в каталоге ВБ/Ozon, ни на складе, идут в
// `meta.newCodes` (см. new-codes.cjs) с названием и кодом фабрики — продавец пометил их «новый товар».
//
// Использование:
//   node scripts/prod-plan.cjs <файл.xlsx> [--date ГГГГ-ММ-ДД] [--new-codes] [--dry]
//   node scripts/prod-plan.cjs add <код 1С> <шт> [--mp ГГГГ-ММ-ДД] [--note "…"]
//   node scripts/prod-plan.cjs reorder <коды через пробел или запятую> [--note "…"] [--off]
//   node scripts/prod-plan.cjs mp <код 1С> <ГГГГ-ММ-ДД>        — срок на МП для заказа «словами» (без срока в файле)
//   node scripts/prod-plan.cjs wait <коды> [--off]             — «ждём партию»: сигнал заказа не считаем, пока
//                                                                 не придёт прошлая партия, которой не видно
//   node scripts/prod-plan.cjs notmp <коды> [--off]            — товар не для маркетплейсов: в новые коды не идёт
//   node scripts/prod-plan.cjs fac                             — коды фабрики из файла в карточки ВБ (файл главнее)
//   node scripts/prod-plan.cjs arrivals [--all]                — приход партий по остаткам своих складов
//   node scripts/prod-plan.cjs list
// ПРИХОД ПАРТИЙ (ЗАП-15): сколько пришло по каждой строке, считает lib/prod-arrivals.cjs по ведомостям 1С —
// после любой команды здесь и после каждой заливки склада (update-warehouse.cjs stock). При перезаливке
// файла строки, которые были и раньше (тот же код · готовность · количество), сохраняют дату появления
// (`since`) — пришедшее по ним не теряется, даже если в новом файле они всё ещё «на МП 05.12».
// СПИСОК «РАССЧИТАТЬ НОВЫЙ ЗАКАЗ» (`prodOrders.reorder`): коды, которых в файле нет, но продавец
// просит считать по ним сигнал «пора заказывать» (27.10.2026 — 10 кодов с пометкой «рассчитать новый
// заказ на производство»). Остальные коды без заказа на сайте — просто «нет в заказе», без сигнала
// (46 кодов он вычеркнул из списка). Список переживает перезаливку файла; `--off` убирает коды.
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require(path.join(__dirname,'node_modules','xlsx'));
const OUT=path.join(__dirname,'..','decrypted');
const ARR=require('./lib/prod-arrivals.cjs');
let argv=process.argv.slice(2);
const take=k=>{ const i=argv.indexOf(k); if(i<0) return null; const v=argv[i+1]; argv.splice(i,2); return v; };
const flag=k=>{ const i=argv.indexOf(k); if(i<0) return false; argv.splice(i,1); return true; };
const dateArg=take('--date'), mpArg=take('--mp'), noteArg=take('--note');
const DRY=flag('--dry'), NEWC=flag('--new-codes'), OFF=flag('--off'), ALL=flag('--all');
const today=dateArg||new Date().toISOString().slice(0,10);

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD; RD.meta=RD.meta||{};
const S=v=>String(v==null?'':v).trim();
const code=v=>S(v).replace(/[\s ,]/g,'');
const F=n=>Math.round(n||0).toLocaleString('ru-RU');
const dmy=iso=>iso? iso.slice(8,10)+'.'+iso.slice(5,7)+'.'+iso.slice(0,4) : '—';
function save(){ if(DRY){ console.log('\n(--dry: снимок не записан)'); return; }
  fs.writeFileSync(path.join(OUT,'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n'); }

/* Партии в `inbound` = заказано − пришло; приход пересчитывается с нуля по ведомостям 1С (lib/prod-arrivals.cjs). */
function rebuildInbound(){ return ARR.computeArrivals(RD); }
const LOOK={'А':'A','В':'B','Е':'E','К':'K','М':'M','Н':'H','О':'O','Р':'P','С':'C','Т':'T','Х':'X','а':'a','е':'e','о':'o','р':'p','с':'c','у':'y','х':'x'};
const facNorm=a=>(/[A-Za-z]/.test(a)&&/[А-Яа-яЁё]/.test(a))? a.replace(/[АВЕКМНОРСТХаеорсух]/g,ch=>LOOK[ch]) : a;
/* Код фабрики из строк файла в карточки ВБ: пусто — дописать, иначе (не только регистр) — заменить файлом. */
function applyFac(rows){
  const wbBy={}; (RD.catalog||[]).forEach(c=>{ const s=code(c.supplierCode); if(s) (wbBy[s]=wbBy[s]||[]).push(c); });
  const artBy={}; rows.forEach(r=>{ if(r.art && !artBy[r.sup]) artBy[r.sup]=r.art; });
  let filled=0; const changed=[];
  Object.entries(artBy).forEach(([s,a])=>{ (wbBy[s]||[]).forEach(c=>{ const cur=S(c.factoryCode);
    if(!cur){ c.factoryCode=a; filled++; }
    else if(cur.replace(/\s/g,'').toLowerCase()!==a.replace(/\s/g,'').toLowerCase()){ changed.push(s+': «'+cur+'» → «'+a+'»'); c.factoryCode=a; } }); });
  return {filled, changed};
}
const codes=()=>argv.slice(1).join(' ').split(/[\s,;]+/).map(code).filter(Boolean);
// список кодов в prodOrders[key]: добавить / убрать (--off)
function listCmd(key,note){
  const cs=codes(); if(!cs.length){ console.error('usage: node scripts/prod-plan.cjs '+argv[0]+' <коды> [--off]'); process.exit(1); }
  if(!RD.prodOrders){ console.error('сначала залей файл заказов'); process.exit(1); }
  const L=RD.prodOrders[key]=(RD.prodOrders[key]||[]).filter(x=>!cs.includes(x.sup));
  if(!OFF) cs.forEach(sup=>L.push({sup,addedAt:today,note:noteArg||note+' (продавец '+dmy(today)+')'}));
  console.log((OFF? 'Убраны из ' : 'Добавлены в ')+key+': '+cs.join(', ')+' · теперь '+L.length);
}
function show(){
  const P=RD.prodOrders; if(!P){ console.log('Заказов на производство в снимке нет.'); return; }
  console.log('Заказы на производство: файл от '+dmy(P.date)+' · строк '+P.rows.length+' · кодов '+new Set(P.rows.map(r=>r.sup)).size);
  const by={}; P.rows.forEach(r=>{ const k=r.st+(r.mp? ' на МП '+r.mp : ''); by[k]=by[k]||{n:0,q:0}; by[k].n++; by[k].q+=r.qty; });
  Object.keys(by).sort().forEach(k=>console.log('   '+k.padEnd(28)+' строк '+String(by[k].n).padStart(3)+' · '+F(by[k].q)+' шт'));
  console.log('Партии в inbound: '+Object.keys(RD.inbound||{}).map(k=>k+' '+F(RD.inbound[k].total)+' шт').join(' · '));
  if((P.reorder||[]).length) console.log('Рассчитать новый заказ (кодов нет в файле): '+P.reorder.map(x=>x.sup).join(', '));
  if((P.wait||[]).length) console.log('Ждём партию (сигнал заказа не считаем): '+P.wait.map(x=>x.sup).join(', '));
  if((P.notMp||[]).length) console.log('Не для маркетплейсов: '+P.notMp.map(x=>x.sup).join(', '));
  const got=P.rows.reduce((a,r)=>a+(r.got||0),0), mg=Object.values(P.missAt||{}).reduce((a,m)=>a+(m.got||0),0);
  console.log('Пришло по ведомостям с даты файла: по идущим партиям '+F(got)+' шт, по прошлым невидимым '+F(mg)+' шт · ведомости по '+dmy(P.arrivalsAt));
}

const cmd=argv[0];
if(cmd==='list'){ show(); process.exit(0); }
if(cmd==='arrivals'){ if(!RD.prodOrders){ console.error('сначала залей файл заказов'); process.exit(1); }
  const log=rebuildInbound(); ARR.printArrivals(log,RD,ALL? null : RD.prodOrders.date); save(); show(); process.exit(0); }
if(cmd==='mp'){
  const sup=code(argv[1]), mp=argv[2];
  if(!sup||!/^\d{4}-\d{2}-\d{2}$/.test(mp||'')){ console.error('usage: node scripts/prod-plan.cjs mp <код 1С> <ГГГГ-ММ-ДД>'); process.exit(1); }
  const rs=(RD.prodOrders&&RD.prodOrders.rows||[]).filter(r=>r.sup===sup&&r.st==='manual');
  if(!rs.length){ console.error('у '+sup+' нет заказа «словами» (manual) — срок строк файла правится в самом файле'); process.exit(1); }
  rs.forEach(r=>{ r.mp=mp; r.note=(r.note? r.note+'; ' : '')+'срок на МП '+dmy(mp)+' со слов продавца '+dmy(today); });
  rebuildInbound(); save(); show(); process.exit(0);
}
if(cmd==='wait'){ listCmd('wait','ждём прошлую партию, новый заказ не считать'); rebuildInbound(); save(); show(); process.exit(0); }
if(cmd==='notmp'){ listCmd('notMp','товар не для маркетплейсов');
  if(!OFF && RD.meta.newCodes && Array.isArray(RD.meta.newCodes.items)){ const cs=codes(); const n0=RD.meta.newCodes.items.length;
    RD.meta.newCodes.items=RD.meta.newCodes.items.filter(x=>!cs.includes(x.code));
    if(RD.meta.newCodes.items.length<n0) console.log('Убрано из новых кодов: '+(n0-RD.meta.newCodes.items.length)); }
  save(); show(); process.exit(0); }
if(cmd==='fac'){ if(!RD.prodOrders){ console.error('сначала залей файл заказов'); process.exit(1); }
  const fixed=[]; RD.prodOrders.rows.forEach(r=>{ const n=facNorm(r.art||''); if(n!==r.art){ fixed.push(r.sup+': «'+r.art+'» → «'+n+'»'); r.art=n; } });
  if(fixed.length){ console.log('Русские буквы-двойники в коде фабрики заменены на латинские:'); [...new Set(fixed)].forEach(f=>console.log('   '+f)); }
  const f=applyFac(RD.prodOrders.rows);
  console.log('Код фабрики: дописан '+f.filled+' · заменён по файлу '+f.changed.length); f.changed.forEach(c=>console.log('   '+c));
  save(); process.exit(0); }
if(cmd==='reorder'){
  const off=OFF;
  const cs=codes();
  if(!cs.length){ console.error('usage: node scripts/prod-plan.cjs reorder <коды> [--note "…"] [--off]'); process.exit(1); }
  if(!RD.prodOrders){ console.error('сначала залей файл заказов'); process.exit(1); }
  const L=RD.prodOrders.reorder=(RD.prodOrders.reorder||[]).filter(x=>!cs.includes(x.sup));
  if(!off) cs.forEach(sup=>L.push({sup,addedAt:today,note:noteArg||'рассчитать новый заказ на производство (продавец '+dmy(today)+')'}));
  rebuildInbound(); save(); show(); process.exit(0);
}
if(cmd==='add'){
  const sup=code(argv[1]), qty=+argv[2]||0;
  if(!sup||!(qty>0)){ console.error('usage: node scripts/prod-plan.cjs add <код 1С> <шт> [--mp ГГГГ-ММ-ДД] [--note "…"]'); process.exit(1); }
  if(!RD.prodOrders){ console.error('сначала залей файл заказов'); process.exit(1); }
  RD.prodOrders.rows.push({sup,art:'',name:'',qty,ready:null,mp:mpArg||null,st:'manual',since:today,note:noteArg||'со слов продавца '+dmy(today)});
  rebuildInbound(); save(); show(); process.exit(0);
}

const file=cmd; if(!file||!fs.existsSync(file)){ console.error('usage: node scripts/prod-plan.cjs <файл.xlsx> [--date] [--new-codes] [--dry]'); process.exit(1); }
const wb=XLSX.readFile(file); const ws=wb.Sheets[wb.SheetNames[0]];
const rr=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:true});
let hi=rr.findIndex(r=>r.some(c=>/^код$/i.test(S(c))));
if(hi<0){ console.error('не нашёл шапку с колонкой «Код»'); process.exit(1); }
const H=rr[hi].map(S);
const col=re=>H.findIndex(h=>re.test(h));
const I={code:col(/^код$/i), art:col(/^артикул/i), name:col(/номенклатур/i), qty:col(/количеств/i),
  ready:col(/готовност/i), mp:col(/приезд|маркетплейс/i)};
const miss=Object.entries(I).filter(([,v])=>v<0).map(([k])=>k);
if(miss.length){ console.error('не нашёл колонки: '+miss.join(', ')+'\nшапка: '+H.join(' | ')); process.exit(1); }
const xd=v=>{ if(typeof v==='number' && v>20000) return new Date(Date.UTC(1899,11,30)+v*864e5).toISOString().slice(0,10);
  const m=S(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/); return m? m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0') : null; };
const yNow=+today.slice(0,4);
const rows=[], fixes=[];
rr.slice(hi+1).forEach((x,i)=>{
  const sup=code(x[I.code]), qty=+S(x[I.qty]).replace(/\s/g,'').replace(',','.')||0;
  if(!sup||!(qty>0)) return;
  let ready=xd(x[I.ready]), mp=xd(x[I.mp]);
  if(ready && +ready.slice(0,4)>yNow+1){ fixes.push(sup+': готовность '+dmy(ready)+' → '+dmy(yNow+ready.slice(4))); ready=yNow+ready.slice(4); }
  if(mp && ready && mp<ready){ const m2=(+mp.slice(0,4)+1)+mp.slice(4); fixes.push(sup+': приезд '+dmy(mp)+' раньше готовности '+dmy(ready)+' → '+dmy(m2)); mp=m2; }
  const art0=S(x[I.art]), art=facNorm(art0); if(art!==art0) fixes.push(sup+': код фабрики «'+art0+'» — русская буква-двойник → «'+art+'»');
  rows.push({sup,art,name:S(x[I.name]),qty,ready,mp,st:mp? 'pending' : 'overdue',
    note:mp? '' : S(x[I.mp]).slice(0,60)});
});
// заказы «словами» (manual) переживают перезаливку файла
const manual=((RD.prodOrders&&RD.prodOrders.rows)||[]).filter(r=>r.st==='manual' && !rows.some(x=>x.sup===r.sup));
manual.forEach(r=>{ if(!r.since) r.since=(RD.prodOrders&&RD.prodOrders.date)||today; });   // приход по нему — с даты, когда заказ появился
const oldKeys=Object.keys(RD.inbound||{}).filter(k=>k!=='china');
const oldOv=Object.keys((RD.meta.etaOverride&&RD.meta.etaOverride.bySup)||{}).length;
const reorder=((RD.prodOrders&&RD.prodOrders.reorder)||[]).filter(x=>!rows.some(r=>r.sup===x.sup));   // попал в файл — сигнал и так считается
/* Строка, которая была и в прошлом файле (код · готовность · количество), сохраняет дату появления: приход
   по ней с тех пор не теряется, хотя в новом файле она всё ещё «на МП 05.12» (продавец не правит файл по приходу). */
const oldP=RD.prodOrders||null, sinceBy={};
((oldP&&oldP.rows)||[]).forEach(r=>{ const k=r.sup+'|'+(r.ready||'')+'|'+r.qty; if(!sinceBy[k]) sinceBy[k]=r.since||oldP.date; });
rows.forEach(r=>{ r.since=sinceBy[r.sup+'|'+(r.ready||'')+'|'+r.qty]||today; });
RD.prodOrders={date:today, src:path.basename(file), loadedAt:new Date().toISOString(), leadDays:180, coverDays:180,
  rows:rows.concat(manual), reorder, wait:(oldP&&oldP.wait)||[], notMp:(oldP&&oldP.notMp)||[], missAt:(oldP&&oldP.missAt)||{}};
ARR.freezeMissing(RD, today);   // прошлые невидимые партии: неизменные переносятся, новые считаются на сегодня
rebuildInbound();
delete RD.meta.etaOverride;
// код фабрики — файл главнее (пусто — дописать, иначе заменить)
const wbBy={}; (RD.catalog||[]).forEach(c=>{ const s=code(c.supplierCode); if(s) (wbBy[s]=wbBy[s]||[]).push(c); });
const ozSet=new Set(((RD.ozon&&RD.ozon.catalog)||[]).map(c=>code(c.sku)));
const whSet=new Set(Object.keys((RD.warehouse&&RD.warehouse.bySup)||{}).map(code));
const facRes=applyFac(rows), filled=facRes.filled, conflict=facRes.changed;
// новые коды
let newAdded=0;
if(NEWC){
  const nc=RD.meta.newCodes&&Array.isArray(RD.meta.newCodes.items)? RD.meta.newCodes.items : [];
  const seen=new Set(nc.map(x=>x.code));
  const notMp=new Set((RD.prodOrders.notMp||[]).map(x=>x.sup));
  [...new Set(rows.map(r=>r.sup))].filter(s=>!wbBy[s]&&!ozSet.has(s)&&!whSet.has(s)&&!seen.has(s)&&!notMp.has(s)).forEach(s=>{
    const r=rows.find(x=>x.sup===s);
    nc.push({code:s, addedAt:today, note:'заказ на производство '+dmy(today)+(r.art? ' · арт. фабрики '+r.art : ''),
      wbSku:null, ozonSku:null, name:r.name||null, factoryCode:r.art||null}); newAdded++; });
  RD.meta.newCodes={items:nc, updatedAt:today, note:(RD.meta.newCodes&&RD.meta.newCodes.note)||null};
}
save();
console.log('Файл: '+path.basename(file)+' · шапка в строке '+(hi+1)+' · строк '+rows.length+' · кодов '+new Set(rows.map(r=>r.sup)).size+' · '+F(rows.reduce((a,r)=>a+r.qty,0))+' шт');
if(fixes.length){ console.log('\nИСПРАВЛЕНЫ ОПЕЧАТКИ В ДАТАХ ('+fixes.length+'):'); fixes.forEach(f=>console.log('   '+f)); }
console.log('\nСтёрто прежнее: партии '+(oldKeys.join(', ')||'—')+' · ручных сроков по кодам '+oldOv);
if(manual.length) console.log('Сохранены заказы «словами»: '+manual.map(r=>r.sup+' '+F(r.qty)+' шт').join(', '));
console.log('Код фабрики дописан: '+filled+' карточек ВБ'+(conflict.length? ' · заменён по файлу '+conflict.length+':' : ''));
conflict.slice(0,30).forEach(c=>console.log('   '+c));
if(NEWC) console.log('Новых кодов в список ожидания: '+newAdded);
console.log('');
show();
