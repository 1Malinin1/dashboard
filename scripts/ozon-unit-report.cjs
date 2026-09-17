// Отчёт Ozon «Юнит-экономика» → REAL_DATA.ozon.meta.unitReports[]
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. Это ЕДИНСТВЕННЫЙ документ Ozon, где написано, сколько площадка реально
// начислила продавцу и сколько удержала. До 17.09.2026 его не было, и два вопроса
// висели открытыми — оба он закрыл сразу:
//
// 1) БАЗА ВЫРУЧКИ. Спор 08.09 («предельная цена» или «цена реализации») решён в пользу
//    ПРЕДЕЛЬНОЙ. Отчёт за август по нашим 92 товарам:
//       «Выручка» (что заплатил покупатель)   21 561 526 ₽ → 2 384 ₽/шт = 72,3% от потолка
//       + «Баллы за скидки» (компенсация Ozon) 7 251 808 ₽
//       + «Программы партнёров»                  197 316 ₽
//       = ЗАСЧИТАНО ПРОДАВЦУ                  29 010 649 ₽ → 3 208 ₽/шт = 97,2% от потолка
//    То есть соинвест приходит продавцу ОТДЕЛЬНОЙ СТРОКОЙ живыми деньгами — ровно как он
//    говорил 04.09 («Озон даёт соинвест за свой счёт»). `revBase.applied=false` подтверждён
//    фактом; включать его нельзя. 72,3% — это цена для покупателя, а не выручка продавца.
//
// 2) ТАРИФ. Сошёлся построчно: вознаграждение Ozon 30,02% при 30% в ИУ, эквайринг 1,30%
//    при 1,3%, логистика 0. Тариф в снимке верный.
//    НО РЕКЛАМА В МОДЕЛИ СТОЯЛА 10%, А ФАКТ АВГУСТА — 4,23%, и вместе с Premium 1,4%
//    (её в отчёте нет вовсе) это давало 42,7% против фактических 35,6%: прибыль августа
//    занижалась на 1 528 870 ₽ (25,6%).
//
// РЕШЕНИЕ ПРОДАВЦА 17.09.2026, ДОСЛОВНО:
//   · реклама — «опирайся на то, что я тебе буду скидывать с отчетов, раньше просто у нас
//     было 10%, сейчас выбрали другой процент оплаты за заказ, в целом я еще сейчас буду
//     другие рекламные компании запускать. То есть то что шло и будет идти в отчетах то
//     и считаешь» → ставка рекламы берётся ИЗ ОТЧЁТА за тот период, который он покрывает;
//   · Premium 1,4% — «вот ее нужно считать по умолчанию, там ее не будет» → остаётся
//     в тарифе всегда, в отчёте её не ищем.
//
// КАК ПРИМЕНЯЕТСЯ СТАВКА РЕКЛАМЫ (`ozAdRateFor` в index.html, `adRateFor` в ozon-finance.cjs
// — ДЕРЖИ СИНХРОННО): день внутри периода отчёта → ставка этого отчёта; день после последнего
// отчёта → ставка последнего (несём вперёд, пока не придёт новый); день раньше первого отчёта
// → ставка первого (другого источника для него нет — то же правило, что у % выкупа).
// ЭТО НЕ «переписывание прошлого», как с % выкупа: отчёт закрытого месяца не дозревает,
// он сразу окончательный, поэтому факт августа законно применяется к августу.
//
// Повторная заливка того же периода ЗАМЕНЯЕТ запись (выгрузка может прийти полнее).
//
// Использование:
//   node scripts/ozon-unit-report.cjs <отчёт.xlsx> [--from ГГГГ-ММ-ДД --to ГГГГ-ММ-ДД]
//   node scripts/ozon-unit-report.cjs list
//   node scripts/ozon-unit-report.cjs drop <от> <до>
'use strict';
const fs=require('fs'), vm=require('vm'), path=require('path');
const {openWorkbook}=require('./xlsx-xml-reader.cjs');
const OUT=path.join(__dirname,'..','decrypted');
const F=v=>Math.round(v).toLocaleString('ru-RU');
const P=v=>v.toFixed(2).replace('.',',');

const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
RD.ozon=RD.ozon||{}; RD.ozon.meta=RD.ozon.meta||{};
const list=RD.ozon.meta.unitReports||(RD.ozon.meta.unitReports=[]);

function show(){
  if(!list.length){ console.log('Отчётов юнит-экономики нет.'); return; }
  console.log('ОТЧЁТЫ ЮНИТ-ЭКОНОМИКИ OZON (по нашим товарам):');
  list.forEach(r=>{
    console.log('  '+r.from+'…'+r.to+'  засчитано '+F(r.gross).padStart(12)+' ₽ ('+F(r.gross/r.del)+' ₽/шт, '+F(r.del)+' шт)'
      +' · комиссия '+P(r.commissionRate)+'% · эквайринг '+P(r.acquiringRate)+'%'
      +' · РЕКЛАМА '+P(r.adsRate)+'%'+(r.builtAt? '   (залит '+r.builtAt.slice(0,10)+')':'')
      +(r.mature===false? '   ← НЕЗРЕЛЫЙ, в расчёт не идёт':''));
  });
  const t=RD.ozon.meta.terms;
  if(t){
    const fixed=+(t.acquiring+t.commission+t.logistics+t.returns+t.crossdock+t.placement+t.other).toFixed(2);
    console.log('');
    console.log('ТАРИФ: фиксированная часть '+P(fixed)+'% (в т.ч. Premium и прочее '+P(t.other)+'% — её в отчёте нет, считаем всегда)');
    console.log('       + реклама по отчёту → итог зависит от периода. Запасная ставка без отчётов: '+P(t.ads)+'%');
  }
}

const argv=process.argv.slice(2);
if(!argv.length||argv[0]==='list'){ show(); process.exit(0); }
if(argv[0]==='drop'){
  const [,f,t]=argv; const i=list.findIndex(r=>r.from===f&&r.to===t);
  if(i<0){ console.error('нет отчёта '+f+'…'+t+'. Есть: '+list.map(r=>r.from+'…'+r.to).join(', ')); process.exit(1); }
  list.splice(i,1); console.log('Отчёт '+f+'…'+t+' удалён.');
  write(); show(); process.exit(0);
}

const file=argv[0];
let FROM=null, TO=null, FROMSRC='name';
for(let i=1;i<argv.length;i++){ if(argv[i]==='--from') FROM=argv[++i]; else if(argv[i]==='--to') TO=argv[++i]; }
if(FROM&&TO) FROMSRC='arg';

/* ПЕРИОД ИЗ ИМЕНИ ФАЙЛА: «…01.08.2026-31.08.2026.xlsx». Имя продавец не переименовывает,
   а внутри листа периода нет ни строкой — только цифры. Без периода отчёт бесполезен:
   непонятно, к каким дням относится ставка рекламы, поэтому при промахе скрипт падает. */
if(!FROM||!TO){
  const m=[...path.basename(file).matchAll(/(\d{2})\.(\d{2})\.(20\d{2})/g)].map(x=>x[3]+'-'+x[2]+'-'+x[1]);
  const u=[...new Set(m)].sort();
  if(u.length>=2){ FROM=FROM||u[0]; TO=TO||u[u.length-1]; }
}

/* ЧИТАЕМ СВОИМ XML-ЧИТАТЕЛЕМ, А НЕ SheetJS (17.09.2026). Отчёт за 01–16.09 пришёл в форме,
   на которой SheetJS ломается: вся кириллица записана числовыми сущностями (&#x410;…) в ячейках
   <c t="str"><v>…</v></c>, и SheetJS теряет старший байт — «Артикул» превращается в мусор,
   колонки не находятся. xlsx-xml-reader.cjs разбирает XML напрямую и отдаёт текст верно
   (в нём для этого добавлены: разворот числовых сущностей, ячейки без атрибута r=,
   разбор rels независимо от порядка атрибутов). Августовский файл читается им же. */
const wbx=openWorkbook(file);
const shName=wbx.sheetNames.find(n=>/юнит/i.test(n))||wbx.sheetNames[0];
const a=wbx.readSheet(shName);
if(!a||!a.length){ console.error('лист «'+shName+'» пуст или не прочитался'); process.exit(1); }

/* ШАПКА НЕ ОБЯЗАТЕЛЬНО В ПЕРВОЙ СТРОКЕ: в августовском файле она строка 1, в сентябрьском —
   строка 4 (перед ней «Период: …», «Расходы на единицу», группирующая строка). Ищем строку,
   где одновременно есть «SKU» и «Артикул». */
let HR=-1;
for(let i=0;i<Math.min(15,a.length);i++){
  const row=(a[i]||[]).map(x=>String(x||'').replace(/\s+/g,' ').trim());
  if(row.includes('SKU') && row.includes('Артикул')){ HR=i; break; }
}
if(HR<0){ console.error('не нашёл шапку (строку с «SKU» и «Артикул») в первых 15 строках листа «'+shName+'»'); process.exit(1); }
const H=(a[HR]||[]).map(x=>String(x||'').replace(/\s+/g,' ').trim());
/* ПЕРИОД ЛУЧШЕ БРАТЬ ИЗ САМОГО ФАЙЛА: сентябрьская форма пишет первой строкой
   «Период: 01.09.2026-16.09.2026». Имя файла остаётся запасным вариантом — августовская
   форма периода внутри не содержит вовсе. Явные --from/--to перекрывают оба. */
{
  const head=a.slice(0,HR).map(r=>(r||[]).join(' ')).join(' ');
  const m=[...head.matchAll(/(\d{2})\.(\d{2})\.(20\d{2})/g)].map(x=>x[3]+'-'+x[2]+'-'+x[1]);
  const u=[...new Set(m)].sort();
  if(u.length>=2 && (FROMSRC!=='arg')){ FROM=u[0]; TO=u[u.length-1]; FROMSRC='file'; }
}
if(!FROM||!TO){ console.error('не понял период отчёта — ни в файле, ни в имени. Укажите: --from ГГГГ-ММ-ДД --to ГГГГ-ММ-ДД'); process.exit(1); }

const ci=n=>{ const i=H.indexOf(n); if(i<0){ console.error('в отчёте нет колонки «'+n+'». Колонки: '+H.join(' · ')); process.exit(1); } return i; };
const I={art:ci('Артикул'), del:ci('Доставлено товаров, шт'), ord:ci('Заказано товаров, шт'),
  ret:ci('Возвращено товаров, шт'), rev:ci('Выручка'), pts:ci('Баллы за скидки'),
  prt:ci('Программы партнёров'), voz:ci('Вознаграждение Ozon'), acq:ci('Эквайринг'),
  prof:ci('Прибыль за период')};
// рекламные и прочие статьи — по имени, если есть
const opt=n=>H.indexOf(n);
const AD=['Оплата за клик','Оплата за заказ','Звёздные товары','Платный бренд','Отзывы'].map(opt).filter(i=>i>=0);
const OTH=['Обработка отправления','Логистика','Доставка до места выдачи','Стоимость размещения',
  'Обработка возврата','Обратная логистика','Утилизация','Дополнительная обработка ОВХ',
  'Операционные ошибки'].map(opt).filter(i=>i>=0);

const N=v=>{ const x=typeof v==='number'?v:parseFloat(String(v==null?0:v).replace(/\s/g,'').replace(',','.')); return isNaN(x)?0:x; };
const sup=new Set((RD.catalog||[]).map(c=>String(c.supplierCode||'').trim()).filter(Boolean));
if(!sup.size){ console.error('в снимке нет каталога ВБ — не с чем сопоставить артикулы'); process.exit(1); }

const T={rows:0,ord:0,del:0,ret:0,rev:0,pts:0,prt:0,voz:0,acq:0,ads:0,oth:0,prof:0};
let foreign=0;
for(let i=HR+1;i<a.length;i++){
  const r=a[i]; if(!r) continue;
  const art=String(r[I.art]==null?'':r[I.art]).trim(); if(!art) continue;
  if(!sup.has(art)){ foreign++; continue; }
  T.rows++;
  T.ord+=N(r[I.ord]); T.del+=N(r[I.del]); T.ret+=N(r[I.ret]);
  T.rev+=N(r[I.rev]); T.pts+=N(r[I.pts]); T.prt+=N(r[I.prt]);
  T.voz+=N(r[I.voz]); T.acq+=N(r[I.acq]); T.prof+=N(r[I.prof]);
  AD.forEach(j=>T.ads+=N(r[j]));
  OTH.forEach(j=>T.oth+=N(r[j]));
}
if(!T.rows){ console.error('в отчёте не нашлось ни одного НАШЕГО артикула (искали по supplierCode ВБ)'); process.exit(1); }
if(!T.del){ console.error('по нашим товарам нет доставленных штук — ставку рекламы считать не от чего'); process.exit(1); }

const gross=T.rev+T.pts+T.prt;
const rec={ from:FROM, to:TO, builtAt:new Date().toISOString(),
  rows:T.rows, ord:T.ord, del:T.del, ret:T.ret,
  rev:T.rev, pts:T.pts, prt:T.prt, gross,
  commission:-T.voz, acquiring:-T.acq, ads:-T.ads, other:-T.oth, profit:T.prof,
  commissionRate:+(-T.voz/gross*100).toFixed(4),
  acquiringRate:+(-T.acq/gross*100).toFixed(4),
  adsRate:+(-T.ads/gross*100).toFixed(4),
  perUnit:+(gross/T.del).toFixed(2),
  src:path.basename(file) };

/* ЗРЕЛОСТЬ ОТЧЁТА — ОБЯЗАТЕЛЬНАЯ ПРОВЕРКА (17.09.2026, поймано на первом же файле).
   Отчёт за НЕЗАКРЫТЫЙ период приходит с выручкой, но БЕЗ удержаний: Ozon начисляет
   комиссию и эквайринг позже. Замер 01–16.09: комиссия 0,72% вместо 30%, эквайринг 0,04%
   вместо 1,3%, реклама 0,15% вместо 4,23% в августе, доставлено/заказано 57,2% против 79,8%.
   Пустить такую ставку рекламы в расчёт — значит сказать, что площадка почти ничего
   не забирает, и раздуть прибыль. Признак надёжный: у зрелого отчёта комиссия совпадает
   с тарифом ИУ (август дал 30,02% при 30%), у незрелого она близка к нулю.
   Такие записи ХРАНИМ (это факт на момент выгрузки), но из выбора ставки ИСКЛЮЧАЕМ —
   см. `mature` в ozAdRateFor()/adRateFor(). */
const COMM=(RD.ozon.meta.terms&&RD.ozon.meta.terms.commission)||30;
rec.mature = rec.commissionRate >= COMM*0.8;
if(!rec.mature) rec.immatureNote='удержания Ozon за период ещё не начислены (комиссия '
  +P(rec.commissionRate)+'% против '+P(COMM)+'% по тарифу) — ставка рекламы из него НЕ берётся';

const at=list.findIndex(r=>r.from===FROM&&r.to===TO);
if(at>=0){ list[at]=rec; console.log('Отчёт '+FROM+'…'+TO+' ПЕРЕЗАПИСАН (был залит раньше).'); }
else { list.push(rec); console.log('Отчёт '+FROM+'…'+TO+' добавлен.'); }
list.sort((x,y)=>x.from<y.from?-1:1);

// Premium остаётся в тарифе всегда; ставка рекламы теперь приходит из отчётов.
const t=RD.ozon.meta.terms;
if(t) t.adsNote='ставка рекламы берётся ИЗ ОТЧЁТА юнит-экономики за период (решение продавца 17.09.2026); '
  +'terms.ads = запасная ставка для дат без отчёта. Premium и прочее '+P(t.other)+'% в отчёте не выделяется — считаем всегда.';

console.log('');
console.log('ОТЧЁТ OZON «ЮНИТ-ЭКОНОМИКА» · '+FROM+' … '+TO+' · ТОЛЬКО НАШИ ТОВАРЫ');
console.log('  строк наших '+T.rows+' (чужих пропущено '+foreign+')');
console.log('  штуки: заказано '+F(T.ord)+' · доставлено '+F(T.del)+' · возвращено '+F(T.ret)
  +'  → доставлено/заказано '+(T.ord?(T.del/T.ord*100).toFixed(1):'—')+'%');
console.log('');
console.log('  «Выручка» (заплатил покупатель)  '+F(T.rev).padStart(13)+' ₽  → '+F(T.rev/T.del)+' ₽/шт');
console.log('  + «Баллы за скидки» (соинвест)   '+F(T.pts).padStart(13)+' ₽');
console.log('  + «Программы партнёров»          '+F(T.prt).padStart(13)+' ₽');
console.log('  = ЗАСЧИТАНО ПРОДАВЦУ             '+F(gross).padStart(13)+' ₽  → '+F(gross/T.del)+' ₽/шт');
console.log('  − вознаграждение Ozon            '+F(-T.voz).padStart(13)+' ₽  = '+P(rec.commissionRate)+'%');
console.log('  − эквайринг                      '+F(-T.acq).padStart(13)+' ₽  = '+P(rec.acquiringRate)+'%');
console.log('  − реклама                        '+F(-T.ads).padStart(13)+' ₽  = '+P(rec.adsRate)+'%   ← идёт в расчёт');
if(T.oth) console.log('  − прочее                         '+F(-T.oth).padStart(13)+' ₽');
console.log('  = «Прибыль за период» Ozon       '+F(T.prof).padStart(13)+' ₽  (себестоимость Ozon не знает)');

// сверка с нашим рядом заказов за тот же период
const S=(RD.ozon.orderSeries)||{dates:[],byArt:{},money:{}};
let oq=0, orub=0;
(S.dates||[]).forEach((d,i)=>{ if(d<FROM||d>TO) return; Object.values(S.byArt||{}).forEach(x=>oq+=x[i]||0); });
Object.keys(S.money||{}).forEach(d=>{ if(d<FROM||d>TO) return; Object.values(S.money[d]).forEach(v=>orub+=v[0]||0); });
if(oq){
  console.log('');
  console.log('  СВЕРКА БАЗЫ ВЫРУЧКИ (цена за штуку):');
  console.log('     наш ряд по «Предельной цене»  '+F(orub/oq).padStart(8)+' ₽/шт   ('+F(oq)+' шт заказано)');
  console.log('     отчёт: засчитано продавцу     '+F(gross/T.del).padStart(8)+' ₽/шт   = '+(gross/T.del/(orub/oq)*100).toFixed(1)+'% от потолка');
  console.log('     отчёт: только «Выручка»       '+F(T.rev/T.del).padStart(8)+' ₽/шт   = '+(T.rev/T.del/(orub/oq)*100).toFixed(1)+'% от потолка');
  const k=gross/T.del/(orub/oq)*100;
  console.log('     → '+(k>=90
    ? 'продавцу засчитывают ПОТОЛОК: база «Предельная цена» верна, revBase оставляем выключенным'
    : 'ВНИМАНИЕ: засчитано заметно ниже потолка — база выручки под вопросом, разберитесь до пересчёта'));
}
if(rec.mature===false){
  console.log('');
  console.log('  ⚠ ОТЧЁТ НЕЗРЕЛЫЙ — В РАСЧЁТ СТАВКИ РЕКЛАМЫ НЕ ПОЙДЁТ.');
  console.log('    '+rec.immatureNote);
  console.log('    Период ещё не закрыт: Ozon начисляет комиссию и эквайринг позже, чем показывает выручку.');
  console.log('    Запись сохранена как факт на момент выгрузки. Перезалейте этот же период,');
  console.log('    когда он закроется, — запись заменится сама.');
}
console.log('');
show();

function write(){
  fs.writeFileSync(path.join(OUT,'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
}
write();
console.log('\nДальше: node scripts/encrypt.cjs <код>');
