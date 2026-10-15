// ОПЛАТА ЗА ЗАКАЗ НА OZON — ФАКТ ИЗ ОТЧЁТА САМОГО OZON, ПО ДНЯМ И ТОВАРАМ.
// Пишет REAL_DATA.ozon.meta.orderFee. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ (продавец 15.10.2026, дословно): «Xway не учитывает дополнительную оплату за заказ,
// дублировать он не может… у меня есть на кабинет подключённое продвижение, которое по
// умолчанию снимает за заказ сейчас 7%, и работу этого инструмента Xway не видит. Поэтому
// я сначала скидываю тебе выгрузку по рекламе с Xway, потом из самого Озона, и тогда мы
// точно получаем расход рекламы, который у меня был за вчера». И про сам отчёт: «в этих
// файлах идёт точное списание за заказ, ставка и т.д. За клики будем брать с Xway».
//
// ПРАВИЛО (действует в дни, за которые отчёт загружен):
//   реклама товара за день = выгрузка XWAY ЦЕЛИКОМ (клики + оплата за заказ, если он сам
//                            её включал в кампании) + списание из ЭТОГО отчёта;
//   модельная ставка из unitReports (5% → 6,26%, 7% → 8,76% в выкупе) в эти дни НЕ берётся,
//   список ozzOn тоже не нужен — отчёт показывает, кому и сколько списали на самом деле.
//   Товар, которого в отчёте за день нет, — списания за заказ у него в этот день не было (0).
//   Дни без отчёта считаются как раньше (ставка + ozzOn), это запасной путь.
//   ДВОЙНОГО СЧЁТА С XWAY НЕТ: XWAY видит только кампании, которые запускал продавец, а этот
//   отчёт — кабинетное продвижение «все товары». Проверено на 14.10: у 487168 в XWAY 1 058 ₽
//   оплаты за заказ, в отчёте 0 — разные инструменты.
//
// ПОЧЕМУ НЕ МОДЕЛЬ. Сверка 01–14.10.2026: модель дашборда (ставка unitReports по всем товарам,
// кроме ozzOn) дала 780 тыс. ₽, факт — 512 тыс. ₽; прибыль Озона за эти дни выросла на 268 тыс. ₽.
// Списывают не со всех заказов (по штукам 48–77% наших заказов), база — цена для покупателя
// (а не «Предельная»), ставки смешаны (5% и 7% в один день), и ozzOn-товарам тоже списывают.
//
// ФОРМАТ. Один лист «Statistics»: строка 0 — «Период: ДД.ММ.ГГГГ - ДД.ММ.ГГГГ», строка 1 —
// «Оплата за заказ (все товары). Отчёт по заказам», дальше шапка: Дата · ID заказа · Номер
// заказа · SKU · SKU продвигаемого товара · Артикул · Название товара · Количество ·
// Стоимость продажи, ₽ · Стоимость, ₽ · Ставка, % · Ставка, ₽ · Расход, ₽. Колонки ПО ИМЕНИ.
// · «Артикул» — артикул ЗАКАЗАННОГО товара (сверено: у 676 строк, где SKU ≠ продвигаемому,
//   артикул совпал с заказанным SKU). Расход приписываем ему — он дал выручку.
// · В отчёте ВЕСЬ кабинет, включая товары другого менеджера (Vulpes и т.п.). Наши — артикул
//   есть в каталоге ВБ (supplierCode) или Озона; чужие только печатаются суммой.
// · Повторная заливка того же периода ЗАМЕНЯЕТ его целиком (по дням периода).
//
// Команды:
//   node scripts/ozon-order-fee.cjs <отчёт1.xlsx> [отчёт2.xlsx …]
//   node scripts/ozon-order-fee.cjs list
//   node scripts/ozon-order-fee.cjs drop <с ГГГГ-ММ-ДД> <по ГГГГ-ММ-ДД>
//
// ДУБЛЬ ЛОГИКИ ПРИМЕНЕНИЯ: ozFinRows()/ozApplyAdFact() в index.html и calc() в
// scripts/ozon-finance.cjs — держать синхронно. ozon-build.cjs переносит поле (9-й капкан).
'use strict';
const fs=require('fs'), vm=require('vm'), path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const DATA=path.join(OUT,'wb-data.js');

const S=v=>(''+(v==null?'':v)).replace(/ /g,' ').replace(/\s+/g,' ').trim();
// число может прийти и числом, и текстом «2,923.00 ₽» / «5.00%»
const num=v=>{ if(typeof v==='number') return v; const t=S(v).replace(/[₽%$\s ]/g,'');
  if(!t) return 0;
  const s = /,\d{3}(\D|$)/.test(t) || /\.\d{1,2}$/.test(t) ? t.replace(/,/g,'') : t.replace(/,/g,'.');
  const n=parseFloat(s); return isNaN(n)?0:n; };
const F=v=>Math.round(v).toLocaleString('ru-RU');
const P2=v=>v.toFixed(2).replace('.',',');
const isIso=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'');
const ruToIso=s=>{ const m=S(s).match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m? m[3]+'-'+m[2]+'-'+m[1] : null; };

const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(DATA,'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD, O=RD.ozon;
if(!O) throw new Error('в снимке нет блока Озона');
O.meta=O.meta||{};

const argv=process.argv.slice(2);
const cmd=argv[0];
if(!cmd){ console.log('Использование: node scripts/ozon-order-fee.cjs <отчёт.xlsx …> | list | drop <с> <по>'); process.exit(1); }

const OF=O.meta.orderFee || {periods:[], byDate:{}};
OF.periods=OF.periods||[]; OF.byDate=OF.byDate||{};
const ozDates=(O.orderSeries&&O.orderSeries.dates)||[];
const ozLast=ozDates[ozDates.length-1]||null;

function save(){
  OF.periods.sort((a,b)=>a.from<b.from?-1:1);
  const keys=Object.keys(OF.byDate).sort(), sorted={}; keys.forEach(k=>sorted[k]=OF.byDate[k]);
  OF.byDate=sorted;
  OF.note='ФАКТ оплаты за заказ из отчёта Ozon «Оплата за заказ (все товары)», ₽ по дням и кодам 1С. '
    +'В дни внутри periods реклама товара = выгрузка XWAY целиком + это списание; модельная ставка '
    +'unitReports и список ozzOn в эти дни не применяются (решение продавца 15.10.2026). '
    +'Ведёт scripts/ozon-order-fee.cjs; применяют ozFinRows/ozApplyAdFact (index.html) и calc (ozon-finance.cjs).';
  O.meta.orderFee=OF;
  fs.writeFileSync(DATA,'// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
}
function dayList(from,to){ const out=[]; const d=new Date(from+'T00:00:00Z'), e=new Date(to+'T00:00:00Z');
  while(d<=e){ out.push(d.toISOString().slice(0,10)); d.setUTCDate(d.getUTCDate()+1); } return out; }
function printList(){
  if(!OF.periods.length){ console.log('Отчётов «Оплата за заказ» в снимке нет — весь период по модельной ставке.'); return; }
  console.log('ОПЛАТА ЗА ЗАКАЗ — ФАКТ ОТЧЁТОВ OZON (наши товары):');
  let tot=0;
  OF.periods.forEach(p=>{ tot+=p.total||0;
    console.log('  '+p.from+(p.to!==p.from? '…'+p.to : '          ')+'  строк '+String(p.rows||0).padStart(4)
      +' · шт '+String(p.qty||0).padStart(4)+' · база '+F(p.rub||0).padStart(10)+' ₽ · списано '
      +F(p.total||0).padStart(8)+' ₽ ('+P2(p.rub? p.total/p.rub*100 : 0)+'% базы)'
      +(p.rates? ' · ставки '+Object.entries(p.rates).map(([k,v])=>k+'%×'+v).join(', ') : ''));
  });
  console.log('  ВСЕГО: '+F(tot)+' ₽');
  // дыры между периодами — дни, где работает модель
  const cov=new Set(); OF.periods.forEach(p=>dayList(p.from,p.to).forEach(d=>cov.add(d)));
  const all=dayList(OF.periods[0].from, OF.periods[OF.periods.length-1].to).filter(d=>!cov.has(d));
  if(all.length) console.log('  ПРОПУСКИ (там модельная ставка): '+all.join(', '));
  const last=OF.periods[OF.periods.length-1].to;
  if(ozLast && ozLast>last) console.log('  После '+last+' отчётов нет — дни по '+ozLast+' считаются по модельной ставке (unitReports).');
}

if(cmd==='list'){ printList(); process.exit(0); }
if(cmd==='drop'){
  const [from,to]=[argv[1],argv[2]];
  if(!isIso(from)||!isIso(to)) throw new Error('drop <с ГГГГ-ММ-ДД> <по ГГГГ-ММ-ДД>');
  const before=OF.periods.length;
  OF.periods=OF.periods.filter(p=>p.to<from||p.from>to);
  dayList(from,to).forEach(d=>delete OF.byDate[d]);
  console.log('Убрано периодов: '+(before-OF.periods.length)+'. Эти дни снова считаются по модельной ставке.');
  save(); printList(); process.exit(0);
}

// ---- заливка файлов
const XLSX=require('xlsx');
// «наши» — как во всех скриптах Озона: код есть у нас (каталог ВБ, каталог Озона, ряды заказов Озона)
const ours=new Set();
(RD.catalog||[]).forEach(c=>{ const s=S(c.supplierCode).replace(/\s/g,''); if(s) ours.add(s); });
(O.catalog||[]).forEach(c=>{ const s=S(c.sku); if(s) ours.add(s); });
Object.keys((O.orderSeries&&O.orderSeries.byArt)||{}).forEach(s=>ours.add(s));
const ozCat=new Set((O.catalog||[]).map(c=>S(c.sku)));

const files=argv.filter(a=>!a.startsWith('--'));
const loaded=[];
for(const f of files){
  const wb=XLSX.readFile(f);
  const sh=wb.Sheets['Statistics']||wb.Sheets[wb.SheetNames[0]];
  const a=XLSX.utils.sheet_to_json(sh,{header:1,defval:'',raw:true});
  const top=a.slice(0,5).map(r=>r.map(S).join(' ')).join(' | ');
  if(!/оплата за заказ/i.test(top))
    throw new Error(path.basename(f)+': это не отчёт «Оплата за заказ» (в шапке: '+top.slice(0,160)+')');
  let hi=-1; for(let i=0;i<Math.min(15,a.length);i++){ const r=a[i].map(S);
    if(r.includes('Дата') && r.includes('Артикул') && r.some(x=>/^Расход/.test(x))){ hi=i; break; } }
  if(hi<0) throw new Error(path.basename(f)+': не нашёл шапку (Дата · Артикул · Расход, ₽). Первые строки:\n'
    +a.slice(0,5).map(r=>'  '+r.map(S).join(' · ')).join('\n'));
  const H=a[hi].map(S), I=n=>H.indexOf(n), IR=re=>H.findIndex(x=>re.test(x));
  const iD=I('Дата'), iA=I('Артикул'), iSp=IR(/^Расход/), iQ=I('Количество'),
        iRub=IR(/^Стоимость, /), iRate=IR(/^Ставка, %/), iName=I('Название товара');
  // период — из строки «Период: …», иначе по датам строк
  const pm=top.match(/Период:\s*(\d{2}\.\d{2}\.\d{4})\s*[-–—]\s*(\d{2}\.\d{2}\.\d{4})/);
  const rows=a.slice(hi+1).filter(r=>ruToIso(r[iD]));
  let from=pm? ruToIso(pm[1]) : null, to=pm? ruToIso(pm[2]) : null;
  if(!from){ const ds=rows.map(r=>ruToIso(r[iD])).sort(); from=ds[0]; to=ds[ds.length-1]; }
  if(!from) throw new Error(path.basename(f)+': нет ни строки «Период», ни строк с датами');
  const byDate={}, stat={rows:0,qty:0,rub:0,total:0,rates:{}}, alien={rows:0,total:0}, outside=[];
  const noCard={};
  rows.forEach(r=>{
    const d=ruToIso(r[iD]), art=S(r[iA]).replace(/\s/g,''), sp=num(r[iSp]);
    if(d<from||d>to){ outside.push(d); return; }
    if(!ours.has(art)){ alien.rows++; alien.total+=sp; return; }
    const day=byDate[d]||(byDate[d]={}); day[art]=(day[art]||0)+sp;
    stat.rows++; stat.qty+=iQ>=0? num(r[iQ]) : 1; stat.rub+=iRub>=0? num(r[iRub]) : 0; stat.total+=sp;
    const rt=iRate>=0? String(+num(r[iRate]).toFixed(2)) : '?'; stat.rates[rt]=(stat.rates[rt]||0)+1;
    if(!ozCat.has(art)) noCard[art]=(iName>=0? S(r[iName]) : '');
  });
  if(outside.length) throw new Error(path.basename(f)+': '+outside.length+' строк вне периода '+from+'…'+to
    +' (например '+outside[0]+') — файл повреждён или период указан неверно, ничего не записано');
  // копейки округляем до 2 знаков уже по сумме дня
  Object.values(byDate).forEach(day=>Object.keys(day).forEach(k=>day[k]=+day[k].toFixed(2)));
  loaded.push({f, from, to, byDate, stat, alien, noCard});
}
loaded.sort((x,y)=>x.from<y.from?-1:1);
for(const L of loaded){
  const repl=OF.periods.filter(p=>!(p.to<L.from||p.from>L.to));
  OF.periods=OF.periods.filter(p=>p.to<L.from||p.from>L.to);
  repl.forEach(p=>dayList(p.from,p.to).forEach(d=>delete OF.byDate[d]));
  dayList(L.from,L.to).forEach(d=>delete OF.byDate[d]);
  dayList(L.from,L.to).forEach(d=>{ OF.byDate[d]=L.byDate[d]||{}; });   // день без наших строк = покрыт, списаний 0
  OF.periods.push({from:L.from, to:L.to, src:path.basename(L.f), rows:L.stat.rows, qty:L.stat.qty,
    rub:Math.round(L.stat.rub), total:+L.stat.total.toFixed(2), rates:L.stat.rates,
    alienRows:L.alien.rows, alienTotal:Math.round(L.alien.total)});
  console.log(L.from+(L.to!==L.from? '…'+L.to:'')+'  '+path.basename(L.f)
    +(repl.length? '  (заменил прежний период '+repl.map(p=>p.from+'…'+p.to).join(', ')+')' : ''));
  console.log('   наши: строк '+L.stat.rows+' · шт '+L.stat.qty+' · база '+F(L.stat.rub)+' ₽ · списано '+F(L.stat.total)
    +' ₽ ('+P2(L.stat.rub? L.stat.total/L.stat.rub*100 : 0)+'% базы) · ставки '
    +Object.entries(L.stat.rates).map(([k,v])=>k+'%×'+v).join(', '));
  console.log('   чужие (другой менеджер, не берём): строк '+L.alien.rows+' · '+F(L.alien.total)+' ₽');
  const nc=Object.keys(L.noCard);
  if(nc.length) console.log('   ВНИМАНИЕ: '+nc.length+' кодов с списанием, но без карточки Озона в снимке: '
    +nc.slice(0,8).map(k=>k+(L.noCard[k]? ' «'+L.noCard[k].slice(0,30)+'»':'')).join(', ')
    +' — расход учтётся строкой без названия');
}
save();
console.log('');
printList();
// дни отчёта позже последнего дня заказов Озона: строки прибыли за них ещё нет, расход не виден
const late=Object.keys(OF.byDate).filter(d=>ozLast && d>ozLast && Object.keys(OF.byDate[d]).length);
if(late.length) console.log('\n  ВНИМАНИЕ: за '+late.join(', ')+' заказов Озона в снимке ещё нет (последний день '+ozLast+').'
  +' Списание за эти дни появится в прибыли, когда будут залиты заказы (ozon-ingest-orders.cjs → ozon-build.cjs).');
console.log('\nДальше: node scripts/ozon-finance.cjs (сверка прибыли) → node scripts/encrypt.cjs <код>');
