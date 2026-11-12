// ОТЧЁТ ОРГАНИЗАЦИИ «Продажи МП» (юнит-экономика 1С, контрагент «РВБ ООО» = Wildberries) → REAL_DATA.meta.ue.
// Это тот отчёт, по которому организация считает ЧИСТУЮ ПРИБЫЛЬ менеджера за календарный месяц, и продавец сверяет
// с ним дашборд (12.11.2026: «мне важно видеть именно такую сумму… пусть ты ошибался, но в 100–150 т.р., а не в миллионы»).
// Поэтому закрытый месяц на дашборде калибруется по этому отчёту (model-finance.cjs), а не наоборот.
//
// ФОРМУЛА ОРГАНИЗАЦИИ (сверена на сентябре 2026, Юдин А.В.: 3 114 645 ₽):
//   выручка по цене продавца = «Продажи стоимость» + |«Скидка (СПП)»|
//   итого к оплате           = выручка − комиссионное вознаграждение − логистика − хранение − штрафы − прочие удержания
//                              − утилизация − страхование + возмещение + доплаты
//   прибыль итоговая         = итого к оплате − себестоимость − продвижение
// Считается ПО ДНЮ ПРОДАЖИ (по отчётам ВБ), за КАЛЕНДАРНЫЙ месяц.
//
// Файл многоуровневый: контрагент → ответственный менеджер → группы → товар. Товар = строка, где заполнен «Код» (код 1С);
// «Код ВБ» — артикул ВБ. Сумма товаров сверяется со строкой менеджера — не сошлось, ничего не пишем.
//
// Использование: node scripts/ue-ingest.cjs <файл.xlsx> [--manager "Юдин"] [--costs] [--dry]
//   --costs  записать себестоимость за штуку из отчёта в каталог с 1-го числа месяца отчёта (costHistory, src:'ue').
//            ПО УМОЛЧАНИЮ НЕ ДЕЛАТЬ: 12.11.2026 продавец проверил расхождения сентября и доказал, что ошибка в
//            себестоимости — у организации («впредь мы будем подобные расхождения разбирать… подсвечивай мне их»).
//            Правильная цена — та, что дал продавец; отчёт организации её не перезаписывает, а сверяется с ней.
//   --drop-costs  убрать из каталога все цены, взятые из отчётов организации (src:'ue'), и выйти.
// ПОДСВЕТКА (печатается всегда и хранится в meta.ue.months[..].flags): где цифры организации расходятся с дашбордом
// или выглядят как ошибка — себестоимость за штуку, комиссия не как у остальных, тяжёлые логистика и штрафы, товар без
// карточки. Это список «что спросить у бухгалтерии», а не поправки к расчёту.
// Дальше: node scripts/model-finance.cjs → node scripts/encrypt.cjs <код>
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const argv=process.argv.slice(2);const file=argv.find(a=>!/^--/.test(a)&&argv[argv.indexOf(a)-1]!=='--manager');
const arg=(k,d)=>{const i=argv.indexOf(k);return i>=0&&argv[i+1]?argv[i+1]:d;};
const MANAGER=arg('--manager','Юдин'), COSTS=argv.includes('--costs'), DRY=argv.includes('--dry');
if(argv.includes('--drop-costs')){
  const cx={};vm.createContext(cx);vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',cx);
  const rd=cx.__RD; let k=0;
  for(const x of rd.catalog){ const h=x.costHistory; if(!h||!h.some(e=>e.src==='ue')) continue;
    x.costHistory=h.filter(e=>e.src!=='ue'); if(x.costHistory.length) x.costPrice=x.costHistory[x.costHistory.length-1].cost; k++; }
  fs.writeFileSync(path.join(OUT,'wb-data.js'),'// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'+'const REAL_DATA = '+JSON.stringify(rd)+';\n');
  console.log('Цены из отчётов организации убраны у '+k+' карточек — действуют цены продавца. Дальше: model-finance.cjs → encrypt.cjs'); process.exit(0); }
if(!file){ console.error('usage: node scripts/ue-ingest.cjs <файл.xlsx> [--manager "Юдин"] [--costs] [--dry]'); process.exit(1); }
const n=v=>typeof v==='number'?v:(parseFloat((''+v).replace(/\s/g,'').replace(',','.'))||0);
const R=x=>Math.round(x).toLocaleString('ru-RU');

const wb=XLSX.readFile(file,{cellStyles:true});
let ws=null,A=null,hRow=-1;
for(const sn of wb.SheetNames){ const a=XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1,defval:'',raw:true});
  const h=a.findIndex(r=>r.indexOf('Продажи стоимость')>=0&&r.indexOf('Прибыль итоговая')>=0);
  if(h>=0){ ws=wb.Sheets[sn]; A=a; hRow=h; break; } }
if(!ws){ console.error('Не нашёл лист с колонками «Продажи стоимость» и «Прибыль итоговая» — это отчёт организации «Продажи МП»?'); process.exit(1); }
const H=A[hRow].map(x=>(''+x).trim()); const col=name=>{const i=H.indexOf(name); if(i<0) console.warn('  ⚠ нет колонки «'+name+'» — считаю нулём'); return i;};
const C={qty:col('Кол-во (продажи, возмещение)'),sales:col('Продажи стоимость'),vozm:col('Возмещение'),spp:col('Скидка (СПП)'),cost:col('Себестоимость стоимость'),
  comm:col('Сумма комиссионного вознаграждения'),log:col('Логистика стоимость'),stor:col('Хранение'),fines:col('Штрафы стоимость'),other:col('Прочие удержания'),
  dopl:col('Доплаты'),util:col('Утилизация стоимость'),ins:col('Страхование'),promo:col('Продвижение'),profit:col('Прибыль итоговая')};
// «Код» и «Код ВБ» — в строке-подписи уровней под шапкой
let iCode=-1,iWb=-1; for(let r=hRow+1;r<hRow+5&&r<A.length;r++){ const x=A[r].map(v=>(''+v).trim()); if(x.indexOf('Код ВБ')>=0){ iWb=x.indexOf('Код ВБ'); iCode=x.indexOf('Код'); } }
if(iCode<0||iWb<0){ console.error('Не нашёл подписи «Код» / «Код ВБ» под шапкой.'); process.exit(1); }
const per=(A.slice(0,hRow).map(r=>r.join(' ')).join(' ').match(/Период:\s*(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/)||[]);
if(!per.length){ console.error('Не нашёл строку «Период: ДД.ММ.ГГГГ - ДД.ММ.ГГГГ».'); process.exit(1); }
const FROM=per[3]+'-'+per[2]+'-'+per[1], TO=per[6]+'-'+per[5]+'-'+per[4], MONTH=FROM.slice(0,7);
const lvl=i=>((ws['!rows']||[])[i]&&(ws['!rows']||[])[i].level)||0;
const iMan=A.findIndex((r,i)=>i>hRow&&lvl(i)===1&&(''+r[0]).indexOf(MANAGER)>=0);
if(iMan<0){ console.error('Не нашёл менеджера «'+MANAGER+'» (строки уровня 1).'); process.exit(1); }
let iEnd=A.length; for(let i=iMan+1;i<A.length;i++){ if(lvl(i)<=1){ iEnd=i; break; } }
const pick=r=>{const o={}; for(const k in C) o[k]=C[k]>=0? n(r[C[k]]) : 0; return o;};
const head=pick(A[iMan]); const items=[];
for(let i=iMan+1;i<iEnd;i++){ const r=A[i]; const code=(''+r[iCode]).trim(); if(!code) continue;
  items.push(Object.assign({code,sku:(''+r[iWb]).trim(),name:(''+r[0]).trim()},pick(r))); }
const tot={}; for(const k in C) tot[k]=items.reduce((a,x)=>a+x[k],0);
const bad=Object.keys(C).filter(k=>Math.abs(tot[k]-head[k])>1);
console.log('Отчёт организации · '+A[iMan][0]+' · '+FROM+' … '+TO+' · товаров '+items.length);
if(bad.length){ console.error('СТОП: сумма товаров не сходится со строкой менеджера по: '+bad.map(k=>k+' '+R(tot[k])+' ≠ '+R(head[k])).join('; ')); process.exit(1); }
const rev=tot.sales-tot.spp, net=rev-tot.comm-tot.log-tot.stor-tot.fines-tot.other-tot.util-tot.ins+tot.vozm+tot.dopl;
console.log('  продано '+R(tot.qty)+' шт · выручка по цене продавца '+R(rev)+' ₽ · итого к оплате '+R(net)+' ₽ ('+(net/rev*100).toFixed(2)+'%)');
console.log('  комиссия '+R(tot.comm)+' · логистика '+R(tot.log)+' · штрафы '+R(tot.fines)+' · хранение '+R(tot.stor)+' · прочие '+R(tot.other)+' · возмещение +'+R(tot.vozm));
console.log('  себестоимость '+R(tot.cost)+' ₽ · продвижение '+R(tot.promo)+' ₽ · ПРИБЫЛЬ ИТОГОВАЯ '+R(tot.profit)+' ₽  (проверка формулы: '+R(net-tot.cost-tot.promo)+')');
if(Math.abs(net-tot.cost-tot.promo-tot.profit)>2){ console.error('СТОП: формула «к оплате − себестоимость − продвижение» не даёт «Прибыль итоговая» — формат отчёта изменился.'); process.exit(1); }

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD; RD.meta=RD.meta||{};
const bySkuCat=new Map(RD.catalog.map(x=>[''+x.sku,x])), bySup=new Map(); RD.catalog.forEach(x=>{ const k=''+x.supplierCode; if(!bySup.has(k)) bySup.set(k,x); });
const bySku={}, noCard=[];
for(const x of items){ let sku=x.sku&&bySkuCat.has(x.sku)? x.sku : (bySup.has(x.code)? ''+bySup.get(x.code).sku : '');
  if(!sku){ noCard.push(x); continue; }
  const o=bySku[sku]||(bySku[sku]={qty:0,rev:0,net:0,cost:0,promo:0,profit:0,codes:[]});
  const r=x.sales-x.spp; o.qty+=x.qty; o.rev+=r; o.net+=r-x.comm-x.log-x.stor-x.fines-x.other-x.util-x.ins+x.vozm+x.dopl; o.cost+=x.cost; o.promo+=x.promo; o.profit+=x.profit; o.codes.push(x.code); }
for(const o of Object.values(bySku)) for(const k of ['rev','net','cost','promo','profit']) o[k]=+o[k].toFixed(2);
console.log('  в каталоге дашборда: '+Object.keys(bySku).length+' карточек · нет в каталоге: '+noCard.length
  +(noCard.length? ' ('+noCard.map(x=>x.code+' '+R(x.profit)+' ₽').join(', ')+')' : ''));

// ---- ПОДСВЕТКА расхождений с дашбордом и подозрительных строк
const costAtCat=(x,d)=>{ const h=x.costHistory; if(!h||!h.length) return x.costPrice||0; let v=x.costPrice||0; for(const e of h){ if(e.src==='ue') continue; if(e.from==null||e.from<=d) v=e.cost; } return v; };
const flags={cost:[],comm:[],hold:[],noCard:noCard.map(x=>({code:x.code,name:x.name.slice(0,50),qty:x.qty,profit:Math.round(x.profit)}))};
const perSku={}; for(const x of items){ const sku=x.sku&&bySkuCat.has(x.sku)? x.sku : (bySup.has(x.code)? ''+bySup.get(x.code).sku : ''); if(!sku) continue;
  const o=perSku[sku]||(perSku[sku]={qty:0,rev:0,cost:0,comm:0,log:0,fines:0,codes:[],name:x.name}); o.qty+=x.qty; o.rev+=x.sales-x.spp; o.cost+=x.cost; o.comm+=x.comm; o.log+=x.log; o.fines+=x.fines; o.codes.push(x.code); }
const commAll=tot.comm/rev; let costDiff=0;
for(const [sku,o] of Object.entries(perSku)){ const x=bySkuCat.get(sku), sup=''+x.supplierCode;
  if(o.qty>=5&&o.cost>0){ const u=o.cost/o.qty, mine=costAtCat(x,TO); if(mine>0){ const d=(u-mine)*o.qty; costDiff+=d;
    if(Math.abs(u/mine-1)>0.03&&Math.abs(d)>=3000) flags.cost.push({sup,name:o.name.slice(0,44),qty:o.qty,theirs:Math.round(u),ours:Math.round(mine),diff:Math.round(d)}); } }
  if(o.rev>30000){ const c=o.comm/o.rev; if(Math.abs(c-commAll)>0.03) flags.comm.push({sup,name:o.name.slice(0,44),rev:Math.round(o.rev),pct:+(c*100).toFixed(1),money:Math.round((c-commAll)*o.rev)});
    const hshare=(o.log+o.fines)/o.rev; if(o.log+o.fines>=15000&&hshare>0.04) flags.hold.push({sup,name:o.name.slice(0,44),log:Math.round(o.log),fines:Math.round(o.fines),pct:+(hshare*100).toFixed(1)}); } }
flags.cost.sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff)); flags.comm.sort((a,b)=>Math.abs(b.money)-Math.abs(a.money)); flags.hold.sort((a,b)=>(b.log+b.fines)-(a.log+a.fines));
flags.costDiffTotal=Math.round(costDiff);
console.log('\nПОДСВЕТКА — что расходится с дашбордом или похоже на ошибку (спросить у организации):');
console.log('  Себестоимость: у организации на '+R(costDiff)+' ₽ '+(costDiff>=0?'БОЛЬШЕ':'МЕНЬШЕ')+', чем по ценам продавца на те же штуки · товаров с отличием >3%: '+flags.cost.length);
flags.cost.slice(0,15).forEach(f=>console.log('     '+f.sup.padEnd(7)+f.name.padEnd(45)+' у них '+R(f.theirs).padStart(6)+' · у нас '+R(f.ours).padStart(6)+' · '+String(f.qty).padStart(4)+' шт · '+(f.diff>=0?'+':'')+R(f.diff)+' ₽'));
console.log('  Комиссия не как у остальных (в среднем '+(commAll*100).toFixed(1)+'%): '+flags.comm.length);
flags.comm.slice(0,8).forEach(f=>console.log('     '+f.sup.padEnd(7)+f.name.padEnd(45)+' '+f.pct+'% · выручка '+R(f.rev)+' · '+(f.money>=0?'+':'')+R(f.money)+' ₽ к среднему'));
console.log('  Логистика и штрафы больше 4% выручки товара: '+flags.hold.length);
flags.hold.slice(0,8).forEach(f=>console.log('     '+f.sup.padEnd(7)+f.name.padEnd(45)+' логистика '+R(f.log)+' · штрафы '+R(f.fines)+' · '+f.pct+'% выручки'));
if(flags.noCard.length) console.log('  Нет карточки в дашборде: '+flags.noCard.map(f=>f.code+' ('+f.qty+' шт, '+R(f.profit)+' ₽)').join(', '));

let costNote='';
if(COSTS){ let ch=0,same=0,few=0; const big=[];
  for(const [sku,o] of Object.entries(bySku)){ if(!(o.qty>=5)||!(o.cost>0)){ few++; continue; }
    const x=bySkuCat.get(sku), u=+(o.cost/o.qty).toFixed(2);
    const h=x.costHistory&&x.costHistory.length? x.costHistory : [{from:null,cost:x.costPrice||0}];
    let cur=x.costPrice||0; for(const e of h){ if(e.from==null||e.from<=FROM) cur=e.cost; }
    if(cur>0&&Math.abs(u/cur-1)<0.005){ same++; continue; }
    if(cur>0&&Math.abs(u/cur-1)>0.15) big.push(x.supplierCode+' '+R(cur)+'→'+R(u));
    const kept=h.filter(e=>e.from==null||e.from<FROM); kept.push({from:FROM,cost:u,src:'ue'});
    const later=h.filter(e=>e.from!=null&&e.from>FROM);          // цены, внесённые продавцом ПОЗЖЕ начала месяца, сильнее
    x.costHistory=kept.concat(later); x.costPrice=x.costHistory[x.costHistory.length-1].cost; ch++; }
  costNote='  себестоимость из отчёта: изменено '+ch+' карточек (с '+FROM+') · без изменений '+same+' · меньше 5 шт, не трогал: '+few
    +(big.length? '\n  отличие больше 15%: '+big.join(', ') : '');
  console.log(costNote); }

RD.meta.ue=RD.meta.ue||{months:{}};
RD.meta.ue.months[MONTH]={from:FROM,to:TO,manager:(''+A[iMan][0]).trim(),loadedAt:new Date().toISOString().slice(0,10),file:path.basename(file).slice(0,60),
  totals:{qty:tot.qty,rev:+rev.toFixed(2),net:+net.toFixed(2),comm:+tot.comm.toFixed(2),log:+tot.log.toFixed(2),fines:+tot.fines.toFixed(2),stor:+tot.stor.toFixed(2),
    other:+tot.other.toFixed(2),vozm:+tot.vozm.toFixed(2),cost:+tot.cost.toFixed(2),promo:+tot.promo.toFixed(2),profit:+tot.profit.toFixed(2)},
  noCard:noCard.map(x=>({code:x.code,name:x.name.slice(0,60),qty:x.qty,profit:+x.profit.toFixed(2)})), flags, bySku};
if(DRY){ console.log('(сухой прогон, ничего не записано)'); process.exit(0); }
fs.writeFileSync(path.join(OUT,'wb-data.js'),'// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('Записано в REAL_DATA.meta.ue.months["'+MONTH+'"]. Дальше: node scripts/model-finance.cjs → node scripts/encrypt.cjs <код>');
