// Отчёт «нужен ли подсорт» — считает то же, что вид «Подсорт со склада» в дашборде,
// но в консоли. ЗАПУСКАТЬ ПОСЛЕ ЛЮБОГО ОБНОВЛЕНИЯ ОСТАТКОВ (ВБ, Озон, свой склад) —
// это правило продавца: после каждой заливки он хочет видеть, что и куда отгружать.
//
// Правила с 27.10.2026 (ПРАВИЛА.md: ЗАП-08, ЗАП-11, ЗАП-13). Считает calc/resupply.js — тот же файл, что у сайта:
//   НАПРАВЛЕНИЯ: ВБ FBO; Ozon «Москва и МО» (ЦФО + Питер + Юг) и «Казань / Нижний Новгород»
//     (Приволжье; склады НН Ozon числит в кластере «Казань»). Кластеры вне округов — не считаем.
//   СКЛАДЫ-ИСТОЧНИКИ: Клин, Евросиб, Нск-1, Москва — в этом порядке (сначала склады без FBS).
//   продаж/дн     = заказы за 7 дней ÷ 7 × % выкупа; у Ozon делится на направления по доле спроса
//                   кластеров (лист «Товар-кластер», `ozon.clusters`);
//   покрытие      = ВБ: остаток на складах WB + журнал отгрузок; Ozon: остаток + в пути кластеров
//                   направления (+ виртуальные «Ozon ЦФО» → Москва, «Ozon СФО» → Казань, без задвоения с заявками);
//   БАЗА          = до 6 месяцев (180 дн) запаса на направлении; Ozon первым, между его
//                   направлениями — по уровню воды; ВБ — из того, что осталось после машин Ozon;
//   МАШИНА        = один склад → одно направление, ровно 33 паллеты и ≤ 6 кодов; последнюю неполную
//                   добиваем, только если базы в ней ≥ 20 паллет, товаром с запасом ≤ 8 месяцев (240 дн);
//                   иначе машина не едет, паллеты остаются на складе.
//
// Использование: node scripts/resupply-report.cjs [-] [сколько строк показать=15]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const TOP=parseInt(process.argv[3],10)||15;

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
// воронка ВБ нужна для % выкупа по окну (лежит в отчётах, а не в каталоге)
let FUNNEL_WB=[];
try{ const c2={};vm.createContext(c2);
  vm.runInContext(fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
    +'\nglobalThis.__F=(typeof BAKED_FUNNEL!=="undefined"? BAKED_FUNNEL:[]);',c2);
  FUNNEL_WB=c2.__F||[]; }catch(e){ FUNNEL_WB=[]; }
const F=n=>Math.round(n).toLocaleString('ru-RU');
const D=v=>v===Infinity?'∞':Math.round(v);

/* ВЕСЬ РАСЧЁТ — calc/resupply.js (с 30.10.2026): тот же файл подключает index.html, поэтому вид «Подсорт со склада»
   и этот отчёт не могут разойтись. Раньше здесь жила вторая копия правил (mpStats/ozSplit/take/waterFill/
   packTrucks/truckConsolidate/truckFill/runTrucks) с пометками «держи синхронно». Ниже — только печать. */
const Resupply=require(path.join(__dirname,'..','calc','resupply.js'));
const RS=Resupply.create(RD,{funnelWb:FUNNEL_WB, funnelOz:(RD.ozon&&RD.ozon.funnel)||[]});
const BUYOUT_WIN=Resupply.BUYOUT_WIN, NSK2_MIN_TAKE=Resupply.NSK2_MIN_TAKE;
const PALLETS_PER_TRUCK=Resupply.PALLETS_PER_TRUCK, MAX_CODES_PER_TRUCK=Resupply.MAX_CODES_PER_TRUCK;
const BASE_DAYS=Resupply.RESUPPLY_DAYS, TOPUP_MAX_DAYS=Resupply.TOPUP_MAX_DAYS, TOPUP_MIN_BASE=Resupply.TOPUP_MIN_BASE;
const WH_ORDER=Resupply.RESUP_WH, WH_NAME=Resupply.RESUP_WH_SHORT, whKey=Resupply.whKey;
// названия направлений для печати (у ВБ в отчёте короче, чем на сайте)
const DIRS=[{key:'oMsk',name:'Ozon · Москва и МО'},{key:'oKzn',name:'Ozon · Казань / Нижний Новгород'},{key:'wFbo',name:'ВБ FBO'}];
const dirByKey=Object.fromEntries(DIRS.map(d=>[d.key,d]));
const BW={wb:RS.buyoutInfo('wb'), ozon:RS.buyoutInfo('ozon')};
const CL=(RD.ozon&&RD.ozon.clusters)||{}, ASG=RS.ozAssignedBySup();
const daysOf=(cov,spd)=> spd>0? cov/spd : (cov>0? Infinity : 0);
const all=RS.resupplyRows();
const plan=all._truckPlan;
// поля отчёта: «have» — что можно отгрузить (без назначенного на Ozon), «rest» — что останется из него после отгрузки
// итоги считаются по ПОЛНОМУ списку (`_allRows`): спрос и запас направления — по всем товарам, а не только по тем, где есть что делать
const rows=all._allRows.map(r=>Object.assign(r,{have:r.haveShip, order:r.onOrder, outShare:r.ozOutShare, rest:r.haveShip-r.shipO-r.shipW}));

// ---- вывод ----
const sum=(f)=>rows.reduce((a,r)=>a+f(r),0);
const needAny=rows.filter(r=>DIRS.some(d=>r.D[d.key].need>0));
const noStock=needAny.filter(r=>r.have<=0);
const urgent=needAny.filter(r=>r.minDays<10);
['wb','ozon'].forEach(mp=>{ const b=BW[mp]; const nm=mp==='wb'?'ВБ  ':'Озон';
  if(!b){ console.log('% выкупа '+nm+': воронки нет → прежний источник'); return; }
  console.log('% выкупа '+nm+': окно '+b.from+'…'+b.to
    +(b.measured? ' (замер отчётом аналитики'+(b.openPct!=null? ', в пути '+b.openPct+'%':'')+')'
                : ' ('+b.days+'/'+BUYOUT_WIN+' дн по воронке)')
    +' → '+(b.all*100).toFixed(1)+'%'
    +(b.mature? ' · ПРИМЕНЕНО'
      : ' · НЕ ЗРЕЛО (выкуп не проставлен за '+b.dead.length+' дн: '
        +b.dead.join(', ')+') → взят прежний источник'));
});
console.log('');
console.log('ПОДСОРТ ПО ПРАВИЛАМ С 27.10 (база '+BASE_DAYS+' дн, добор от '+TOPUP_MIN_BASE+' палл товаром до '
  +TOPUP_MAX_DAYS+' дн) · остатки ВБ на '+((RD.meta&&RD.meta.stockSnapshotDate)||'—')
  +' · Озон на '+((RD.ozon&&RD.ozon.meta&&RD.ozon.meta.stockDate)||'—')
  +' (кластеры на '+(CL.date||'—')+') · склад на '+((RD.warehouse&&RD.warehouse.date)||'не загружен'));
console.log('─'.repeat(100));
DIRS.forEach(d=>{ const k=d.key;
  const ship=sum(r=>r.D[k].ship), pcs=sum(r=>WH_ORDER.reduce((a,w)=>a+r.D[k].pcs[w],0));
  const need=sum(r=>r.D[k].need), top=sum(r=>r.D[k].topUp), roll=sum(r=>r.D[k].roll);
  const spd=sum(r=>r.D[k].spd), cov=sum(r=>r.D[k].cov);
  console.log((d.name+':').padEnd(34)+' к отгрузке '+F(ship).padStart(7)+' шт'
    +(pcs? ' (из них штучно '+F(pcs)+')':'')
    +' · до 6 мес не хватает '+F(need)+' · добор '+F(top)+' · не едет '+F(roll)
    +' · спрос '+spd.toFixed(1)+'/дн · запас был '+D(daysOf(cov,spd))+' дн → стал '+D(daysOf(cov+ship,spd))+' дн'); });
{ const out=sum(r=>r.oSpd*r.outShare), all=sum(r=>r.oSpd);
  console.log('Спрос Ozon вне двух направлений (Урал, Сибирь, ДВ и др.) — не считаем: '+out.toFixed(1)+'/дн из '
    +all.toFixed(1)+' ('+(all? Math.round(out/all*100):0)+'%)'); }
{ const sfo=Object.values(ASG).reduce((a,v)=>a+v.sfo,0), cfo=Object.values(ASG).reduce((a,v)=>a+v.cfo,0);
  if(sfo+cfo>0) console.log('Назначено на Ozon (виртуальные склады): ЦФО '+F(cfo)+' шт → покрытие «Москва и МО»; СФО '
    +F(sfo)+' шт → покрытие «Казань / НН» (в Сибирь не везём, ЗАП-11)'); }
console.log('Требуют отгрузки: '+needAny.length+' позиций · нечем закрыть (на своих складах пусто): '+noStock.length
  +' · срочно (запас < 10 дн): '+urgent.length);
{ const byW={}; WH_ORDER.forEach(w=>{ byW[w]=sum(r=>r.pool[w]); });
  const tot=sum(r=>r.have);
  console.log('Останется на своих складах: '+F(sum(r=>r.rest))+' шт из '+F(tot)+' (без назначенного на Ozon): '
    +WH_ORDER.map(w=>WH_NAME[w]+' '+F(byW[w])).join(' · ')
    +(sum(r=>r.whNsk2>0&&r.whNsk2<NSK2_MIN_TAKE? r.whNsk2:0)? ' + мелочь Евросиба <'+NSK2_MIN_TAKE+' шт не берём' : '')); }
{ const h=sum(r=>WH_ORDER.reduce((a,w)=>a+r.hold[w],0));
  if(h) console.log('Из них держим за Ozon (машина Ozon не собралась, на ВБ не отдаём): '+F(h)+' шт'); }
const fbsLeft=sum(r=>r.pool.nsk1+r.pool.msk);
console.log('Под FBS ВБ остаётся (Нск-1 + Москва): '+F(fbsLeft)+' шт');

if(plan.length){
  console.log('\nПЛАН МАШИН ('+PALLETS_PER_TRUCK+' паллет, ≤ '+MAX_CODES_PER_TRUCK+' кодов, один склад → одно направление):');
  plan.forEach(p=>{ const nm=WH_NAME[p.whKey]+' → '+dirByKey[p.dir].name;
    console.log('  '+nm.padEnd(46)+String(p.total).padStart(4)+' палл · '+p.trucks.length+' маш · '+p.codes+' кодов'
      +(p.droppedPallets? ' · НЕ ЕДЕТ '+p.droppedPallets+' палл':''));
    p.trucks.forEach((t,i)=>console.log('      Машина '+String(i+1).padEnd(4)+t.pallets+' палл'
      +(t.base!=null && t.base<t.pallets? ' (база '+t.base+' + добор '+(t.pallets-t.base)+')':'')
      +' · '+t.items.length+' кодов: '+t.items.map(x=>x.sup+'×'+x.pal).join(', ')));
    p.dropped.forEach(t=>console.log('      Не едет    '+t.pallets+' палл · '+t.why+': '
      +t.items.map(x=>x.sup+'×'+x.pal).join(', '))); });
  console.log('  ИТОГО: '+plan.reduce((a,p)=>a+p.trucks.length,0)+' машин · '+F(plan.reduce((a,p)=>a+p.total,0))+' палл');
  /* РЕЗЕРВ 1С ПОД КОДАМИ ПЛАНА (с 28.10.2026). Резерв — товар, который уже собирают в отгрузку; куда он едет,
     ведомость не говорит (продавец 28.10: способ передавать направление пока не нашёл). Пока он не виден в «в пути»
     площадки, расчёт его не учитывает и может предложить тот же код повторно (28.10: обе машины Ozon «Москва» —
     12 кодов из 12 в резерве). Только печать — машины не меняем; продавцу сказать перед отгрузкой. */
  const resPt=((RD.whHistory||{})[(RD.warehouse||{}).date]||{}).reserve||{};
  const resAt=(sup,wh)=>{ const r=resPt[sup]; if(!r) return 0; let q=0; Object.entries(r.wh||{}).forEach(([n,v])=>{ if(whKey(n)===wh) q+=v; }); return q; };
  const warn=[];
  plan.forEach(p=>p.trucks.forEach((t,i)=>{ const hit=t.items.map(x=>({sup:x.sup,q:resAt(x.sup,p.whKey)})).filter(x=>x.q>0);
    if(hit.length) warn.push('  '+WH_NAME[p.whKey]+' → '+dirByKey[p.dir].name+' · машина '+(i+1)+': '+hit.length+' из '+t.items.length
      +' кодов уже в резерве — '+hit.map(x=>x.sup+' ('+F(x.q)+' шт)').join(', ')); }));
  if(warn.length) console.log('\n⚠ В РЕЗЕРВЕ 1С (собирают отгрузку, в «в пути» площадки ещё не видно — проверить, не повтор ли):\n'+warn.join('\n'));
}
const noPal=rows.filter(r=>r.noPal);
if(noPal.length) console.log('\nБез вместимости паллеты (везём штуками, вне машин): '+noPal.length+' позиций: '
  +noPal.map(r=>r.sup+' '+F(r.shipO+r.shipW)).join(', '));
const toShip=rows.filter(r=>r.shipO>0||r.shipW>0);
if(toShip.length){
  console.log('\nЧТО ОТГРУЗИТЬ (топ-'+TOP+' по количеству):');
  console.log('  код 1С    склад  →Оз.Мск →Оз.Каз   →ВБ    Клин Евросиб  Нск-1    Мск   ост.  дн Мск  дн Каз  дн ВБ  товар');
  toShip.sort((a,b)=>(b.shipO+b.shipW)-(a.shipO+a.shipW)).slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+String(r.have).padStart(6)+String(r.D.oMsk.ship||'-').padStart(8)
      +String(r.D.oKzn.ship||'-').padStart(8)+String(r.D.wFbo.ship||'-').padStart(6)
      +String(r.whKlin).padStart(8)+String(r.whNsk2).padStart(8)+String(r.whNsk1).padStart(7)
      +String(r.whMsk).padStart(7)+String(r.rest).padStart(7)
      +String(D(r.D.oMsk.days)).padStart(8)+String(D(r.D.oKzn.days)).padStart(8)+String(D(r.D.wFbo.days)).padStart(7)
      +'  '+(r.name||'').slice(0,28)));
}
if(urgent.length){
  console.log('\nСРОЧНО (запас на площадке меньше 10 дней):');
  urgent.sort((a,b)=>a.minDays-b.minDays).slice(0,TOP).forEach(r=>
    console.log('  '+r.sup.padEnd(9)+'Оз '+String(D(r.oDays)).padStart(4)+' дн · ВБ '+String(D(r.wDays)).padStart(4)+' дн'
      +' · везём Оз '+String(r.shipO).padStart(5)+' ВБ '+String(r.shipW).padStart(5)+' · на складе '+String(r.have).padStart(6)
      +(r.have<=0? (r.china||r.order? '  (едет: '+(r.china?'Китай '+r.china:'')+(r.china&&r.order?' + ':'')+(r.order?'произв. '+r.order:'')+')' : '  (взять негде)') : '')
      +'  '+(r.name||'').slice(0,34)));
}
// ---- самопроверка правил ЗАП-13 (печатает только нарушения) ----
{ const bad=[];
  rows.forEach(r=>WH_ORDER.forEach(w=>{ if(r.pool[w]<0) bad.push(r.sup+': склад '+WH_NAME[w]+' ушёл в минус '+r.pool[w]);
    if(r.hold[w]<0) bad.push(r.sup+': отрицательное «держим за Ozon»'); }));
  rows.forEach(r=>{ if(r.shipO+r.shipW>r.have) bad.push(r.sup+': отгрузка '+(r.shipO+r.shipW)+' больше склада '+r.have); });
  plan.forEach(pe=>{
    pe.trucks.forEach((t,i)=>{ const pl=t.items.reduce((a,x)=>a+x.pal,0);
      if(pl!==PALLETS_PER_TRUCK||t.items.length>MAX_CODES_PER_TRUCK) bad.push(WH_NAME[pe.whKey]+'→'+pe.dir+' машина '+(i+1)+': '+pl+' палл / '+t.items.length+' кодов');
      if(t.base!=null && t.base<t.pallets && t.base<TOPUP_MIN_BASE) bad.push(WH_NAME[pe.whKey]+'→'+pe.dir+' машина '+(i+1)+': добита при базе '+t.base); });
    const inPlan={}; pe.trucks.forEach(t=>t.items.forEach(x=>{ inPlan[x.sup]=(inPlan[x.sup]||0)+x.pal; }));
    rows.forEach(r=>{ const a=r.D[pe.dir].pal[pe.whKey]||0, b=inPlan[r.sup]||0;
      if(a!==b) bad.push(r.sup+' '+WH_NAME[pe.whKey]+'→'+pe.dir+': в строке '+a+' палл, в машинах '+b); }); });
  rows.forEach(r=>DIRS.forEach(d=>{ const x=r.D[d.key]; if(x.topUp>0 && x.spd>0 && (x.cov+x.ship)/x.spd>TOPUP_MAX_DAYS+1e-9)
    bad.push(r.sup+' '+d.key+': добран выше '+TOPUP_MAX_DAYS+' дн ('+Math.round((x.cov+x.ship)/x.spd)+')'); }));
  console.log(bad.length? '\nНАРУШЕНИЯ ПРАВИЛ ('+bad.length+'):\n  '+bad.slice(0,30).join('\n  ') : '\nСамопроверка: машины по 33 паллеты и ≤ 6 кодов, отгрузка ≤ склада, добор ≤ 8 мес и только от 20 паллет базы — нарушений нет');
}
console.log('\nПодробности и выгрузка — вкладка «Оборачиваемость» → «Подсорт со склада».');
