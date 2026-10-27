// ЗАКАЗЫ НА ПРОИЗВОДСТВО — ВЕСЬ ФАЙЛ ПРОДАВЦА ЦЕЛИКОМ (с 27.10.2026; правило ЗАП-14 в ПРАВИЛА.md).
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
// КОД ФАБРИКИ: колонка «Артикул» дописывается в `catalog[].factoryCode` ТОЛЬКО там, где он пуст
// («поле частично заполнено… нужно просто добавить недостающие»); расхождения печатаются.
// НОВЫЕ КОДЫ (`--new-codes`): коды файла, которых нет ни в каталоге ВБ/Ozon, ни на складе, идут в
// `meta.newCodes` (см. new-codes.cjs) с названием и кодом фабрики — продавец пометил их «новый товар».
//
// Использование:
//   node scripts/prod-plan.cjs <файл.xlsx> [--date ГГГГ-ММ-ДД] [--new-codes] [--dry]
//   node scripts/prod-plan.cjs add <код 1С> <шт> [--mp ГГГГ-ММ-ДД] [--note "…"]
//   node scripts/prod-plan.cjs reorder <коды через пробел или запятую> [--note "…"] [--off]
//   node scripts/prod-plan.cjs list
// СПИСОК «РАССЧИТАТЬ НОВЫЙ ЗАКАЗ» (`prodOrders.reorder`): коды, которых в файле нет, но продавец
// просит считать по ним сигнал «пора заказывать» (27.10.2026 — 10 кодов с пометкой «рассчитать новый
// заказ на производство»). Остальные коды без заказа на сайте — просто «нет в заказе», без сигнала
// (46 кодов он вычеркнул из списка). Список переживает перезаливку файла; `--off` убирает коды.
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require(path.join(__dirname,'node_modules','xlsx'));
const OUT=path.join(__dirname,'..','decrypted');
let argv=process.argv.slice(2);
const take=k=>{ const i=argv.indexOf(k); if(i<0) return null; const v=argv[i+1]; argv.splice(i,2); return v; };
const flag=k=>{ const i=argv.indexOf(k); if(i<0) return false; argv.splice(i,1); return true; };
const dateArg=take('--date'), mpArg=take('--mp'), noteArg=take('--note');
const DRY=flag('--dry'), NEWC=flag('--new-codes');
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

/* Партии в `inbound` пересобираются из `prodOrders.rows` — одна функция для загрузки и для `add`. */
function rebuildInbound(){
  const P=RD.prodOrders; const keep={};
  if(RD.inbound && RD.inbound.china) keep.china=RD.inbound.china;      // «едет из Китая» — другой отчёт
  const groups={};
  P.rows.filter(r=>r.st==='pending'||r.st==='manual').forEach(r=>{
    const k=r.mp? 'p'+r.mp.replace(/-/g,'') : 'pmanual';
    const g=groups[k]||(groups[k]={label:(r.mp? 'Заказ производству · на МП '+dmy(r.mp) : 'Заказано производству · срок не указан'),
      date:P.date, total:0, bySup:{}, eta:null, etaSale:r.mp||null, src:'prod-plan'});
    g.bySup[r.sup]=(g.bySup[r.sup]||0)+r.qty; g.total+=r.qty; });
  RD.inbound=Object.assign(keep,groups);
}
function show(){
  const P=RD.prodOrders; if(!P){ console.log('Заказов на производство в снимке нет.'); return; }
  console.log('Заказы на производство: файл от '+dmy(P.date)+' · строк '+P.rows.length+' · кодов '+new Set(P.rows.map(r=>r.sup)).size);
  const by={}; P.rows.forEach(r=>{ const k=r.st+(r.mp? ' на МП '+r.mp : ''); by[k]=by[k]||{n:0,q:0}; by[k].n++; by[k].q+=r.qty; });
  Object.keys(by).sort().forEach(k=>console.log('   '+k.padEnd(28)+' строк '+String(by[k].n).padStart(3)+' · '+F(by[k].q)+' шт'));
  console.log('Партии в inbound: '+Object.keys(RD.inbound||{}).map(k=>k+' '+F(RD.inbound[k].total)+' шт').join(' · '));
  if((P.reorder||[]).length) console.log('Рассчитать новый заказ (кодов нет в файле): '+P.reorder.map(x=>x.sup).join(', '));
}

const cmd=argv[0];
if(cmd==='list'){ show(); process.exit(0); }
if(cmd==='reorder'){
  const off=flag('--off');
  const cs=argv.slice(1).join(' ').split(/[\s,;]+/).map(code).filter(Boolean);
  if(!cs.length){ console.error('usage: node scripts/prod-plan.cjs reorder <коды> [--note "…"] [--off]'); process.exit(1); }
  if(!RD.prodOrders){ console.error('сначала залей файл заказов'); process.exit(1); }
  const L=RD.prodOrders.reorder=(RD.prodOrders.reorder||[]).filter(x=>!cs.includes(x.sup));
  if(!off) cs.forEach(sup=>L.push({sup,addedAt:today,note:noteArg||'рассчитать новый заказ на производство (продавец '+dmy(today)+')'}));
  save(); show(); process.exit(0);
}
if(cmd==='add'){
  const sup=code(argv[1]), qty=+argv[2]||0;
  if(!sup||!(qty>0)){ console.error('usage: node scripts/prod-plan.cjs add <код 1С> <шт> [--mp ГГГГ-ММ-ДД] [--note "…"]'); process.exit(1); }
  if(!RD.prodOrders){ console.error('сначала залей файл заказов'); process.exit(1); }
  RD.prodOrders.rows.push({sup,art:'',name:'',qty,ready:null,mp:mpArg||null,st:'manual',note:noteArg||'со слов продавца '+dmy(today)});
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
  rows.push({sup,art:S(x[I.art]),name:S(x[I.name]),qty,ready,mp,st:mp? 'pending' : 'overdue',
    note:mp? '' : S(x[I.mp]).slice(0,60)});
});
// заказы «словами» (manual) переживают перезаливку файла
const manual=((RD.prodOrders&&RD.prodOrders.rows)||[]).filter(r=>r.st==='manual' && !rows.some(x=>x.sup===r.sup));
const oldKeys=Object.keys(RD.inbound||{}).filter(k=>k!=='china');
const oldOv=Object.keys((RD.meta.etaOverride&&RD.meta.etaOverride.bySup)||{}).length;
const reorder=((RD.prodOrders&&RD.prodOrders.reorder)||[]).filter(x=>!rows.some(r=>r.sup===x.sup));   // попал в файл — сигнал и так считается
RD.prodOrders={date:today, src:path.basename(file), loadedAt:new Date().toISOString(), leadDays:180, coverDays:180,
  rows:rows.concat(manual), reorder};
rebuildInbound();
delete RD.meta.etaOverride;
// код фабрики — только недостающие
const wbBy={}; (RD.catalog||[]).forEach(c=>{ const s=code(c.supplierCode); if(s) (wbBy[s]=wbBy[s]||[]).push(c); });
const ozSet=new Set(((RD.ozon&&RD.ozon.catalog)||[]).map(c=>code(c.sku)));
const whSet=new Set(Object.keys((RD.warehouse&&RD.warehouse.bySup)||{}).map(code));
let filled=0; const conflict=[];
const artBy={}; rows.forEach(r=>{ if(r.art && !artBy[r.sup]) artBy[r.sup]=r.art; });
Object.entries(artBy).forEach(([s,a])=>{ (wbBy[s]||[]).forEach(c=>{ const cur=S(c.factoryCode);
  if(!cur){ c.factoryCode=a; filled++; } else if(cur.replace(/\s/g,'').toLowerCase()!==a.replace(/\s/g,'').toLowerCase()) conflict.push(s+': в каталоге «'+cur+'», в файле «'+a+'»'); }); });
// новые коды
let newAdded=0;
if(NEWC){
  const nc=RD.meta.newCodes&&Array.isArray(RD.meta.newCodes.items)? RD.meta.newCodes.items : [];
  const seen=new Set(nc.map(x=>x.code));
  [...new Set(rows.map(r=>r.sup))].filter(s=>!wbBy[s]&&!ozSet.has(s)&&!whSet.has(s)&&!seen.has(s)).forEach(s=>{
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
console.log('Код фабрики дописан: '+filled+' карточек ВБ'+(conflict.length? ' · расхождений '+conflict.length+' (не трогал):' : ''));
conflict.slice(0,30).forEach(c=>console.log('   '+c));
if(NEWC) console.log('Новых кодов в список ожидания: '+newAdded);
console.log('');
show();
