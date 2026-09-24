// ЗАКАЗ НА ПРОИЗВОДСТВО (Китай) — заливка ОТДЕЛЬНОЙ партии со своими сроками прихода.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ `update-warehouse.cjs order`. Тот читает выгрузку 1С
// «Ведомость по заказам поставщикам» и ПЕРЕЗАПИСЫВАЕТ `inbound.order` целиком — одна партия,
// один срок. Но продавец размещает заказы несколькими партиями, и у каждой свой срок:
// первая (05.08.2026, 85 372 шт) приходит 09.11.2026, вторая (22.09.2026, 28 390 шт) —
// 15.01.2027. Залить вторую поверх первой значило бы стереть 85 372 шт из «Есть сейчас»
// в ЗАКУПЕ и заказать их на фабрике второй раз. Поэтому каждая партия живёт своим ключом
// `inbound.order2`, `order3`, … , а дашборд перечисляет ключи (`inbKeys()` в index.html),
// а не ходит по именам `china`/`order`.
//
// ФОРМАТ ФАЙЛА (рабочий файл заказа продавца, один лист):
//   № · Код · Артикул · Номенклатура · Количество · Срок изготовления · Срок прихода
// Колонки ищутся ПО ИМЕНИ (порядок в файлах продавца плавает), даты принимаются и текстом
// «15.01.2027», и числом Excel. «Код» — это КОД 1С (он же supplierCode ВБ и артикул Озона),
// приходит с пробелами-разрядами («487 161») и иногда с запятой («474,092») — чистим оба.
//
// ДВЕ ДАТЫ У ПАРТИИ, И В ФАЙЛЕ ЕСТЬ ТОЛЬКО ОДНА. «Срок прихода» — это приход НА СКЛАД
// ПРОДАВЦА (`eta`). До выхода В ПРОДАЖУ на площадке нужен ещё примерно месяц на приёмку
// и отгрузку — это `etaSale`, по ней считает «Запас и темп». Скрипт ставит её сам
// (`eta` + SALE_LAG дней) и ГРОМКО об этом пишет; точную дату задаёт `set-eta.cjs`.
//
// КОД, КОТОРОГО НЕТ В КАТАЛОГЕ, НЕ МОЛЧИТ. Заказ на фабрику может содержать позицию,
// карточки которой ещё нет, — она законно попадает в партию (товар приедет и его заведут),
// но печатается отдельным списком: чаще это опечатка в коде, а тихо принятая опечатка
// означает, что штуки не найдут свой товар и выпадут из расчёта.
//
// Использование:
//   node scripts/prod-order.cjs <файл.xlsx> [--key order2] [--label "Заказ 22.09"] [--sale ГГГГ-ММ-ДД]
//   node scripts/prod-order.cjs list                 — что сейчас лежит в снимке
//   node scripts/prod-order.cjs drop <ключ>          — убрать партию целиком
// Дальше: node scripts/encrypt.cjs <код>
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require(path.join(__dirname,'node_modules','xlsx'));
const OUT=path.join(__dirname,'..','decrypted');
const SALE_LAG=31;          // приход на склад → выход в продажу, дней

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD; RD.inbound=RD.inbound||{};
const F=n=>Math.round(n).toLocaleString('ru-RU');
const today=new Date().toISOString().slice(0,10);
const days=(a,b)=>Math.round((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/864e5);
const save=()=>fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const argv=process.argv.slice(2);
const flag=n=>{const i=argv.indexOf('--'+n); return i>=0? argv[i+1] : null;};
const isOrderKey=k=>k!=='china' && RD.inbound[k] && RD.inbound[k].bySup;

// ---------- list
if(argv[0]==='list' || !argv[0]){
  const keys=Object.keys(RD.inbound).filter(k=>RD.inbound[k]&&RD.inbound[k].bySup);
  if(!keys.length){ console.log('партий в снимке нет'); process.exit(0); }
  let tot=0;
  keys.sort((a,b)=>((RD.inbound[a].eta||'9999')+a).localeCompare((RD.inbound[b].eta||'9999')+b))
    .forEach(k=>{ const b=RD.inbound[k]; tot+=(b.total||0);
      const n=Object.keys(b.bySup||{}).length;
      console.log('['+k+'] '+(b.label||(k==='china'?'Едет из Китая':'Заказано производству')));
      console.log('   '+F(b.total||0)+' шт по '+n+' кодам · заведена '+(b.date||'—'));
      const p=(lbl,d)=>{ if(!d){ console.log('   '+lbl+': не задан'); return; }
        const dd=days(today,d); console.log('   '+lbl+': '+d+(dd>=0?' (через '+dd+' дн)':' — ПРОСРОЧЕН на '+(-dd)+' дн')); };
      p('приход НА СКЛАД ', b.eta); p('ВЫХОД В ПРОДАЖУ', b.etaSale);
    });
  console.log('\nВСЕГО едет к продавцу: '+F(tot)+' шт');
  process.exit(0);
}
// ---------- drop
if(argv[0]==='drop'){
  const k=argv[1];
  if(!k||!RD.inbound[k]){ console.error('usage: node scripts/prod-order.cjs drop <ключ>   (см. list)'); process.exit(1); }
  const was=RD.inbound[k].total||0; delete RD.inbound[k]; save();
  console.log('Убрана партия ['+k+'] — '+F(was)+' шт');
  console.log('\nДальше: node scripts/encrypt.cjs <код>'); process.exit(0);
}

// ---------- заливка файла
const file=argv.filter(a=>!a.startsWith('--') && argv[argv.indexOf(a)-1]!=='--key'
  && argv[argv.indexOf(a)-1]!=='--label' && argv[argv.indexOf(a)-1]!=='--sale')[0];
if(!file||!fs.existsSync(file)){ console.error('не найден файл: '+file); process.exit(1); }

const wb=XLSX.readFile(file);
const sheet=wb.SheetNames[0];
const A=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{header:1,raw:true,defval:''});
const nb=s=>(''+(s==null?'':s)).replace(/[\s  ]+/g,' ').trim().toLowerCase();
let hr=-1;
for(let i=0;i<Math.min(15,A.length);i++){ const h=(A[i]||[]).map(nb);
  if(h.some(x=>x==='код') && h.some(x=>/количеств/.test(x))){ hr=i; break; } }
if(hr<0){ console.error('НЕ НАЙДЕНА ШАПКА (нужны колонки «Код» и «Количество»). Первые строки файла:');
  A.slice(0,8).forEach((r,i)=>console.error('  '+i+': '+r.map(x=>''+x).join(' | '))); process.exit(1); }
const H=(A[hr]||[]).map(nb);
const col=(re,must)=>{ const i=H.findIndex(x=>re.test(x));
  if(i<0&&must){ console.error('НЕТ КОЛОНКИ '+re+'. Шапка файла: '+H.join(' | ')); process.exit(1); } return i; };
const iCode=H.findIndex(x=>x==='код'), iQty=col(/количеств/,true),
      iName=col(/номенклатур|наименован/,false), iArt=col(/артикул/,false),
      iMade=col(/срок.*изготов/,false), iEta=col(/срок.*приход/,false);
if(iCode<0){ console.error('НЕТ КОЛОНКИ «Код». Шапка файла: '+H.join(' | ')); process.exit(1); }

const iso=v=>{ if(v===''||v==null) return null;
  if(typeof v==='number'){ return new Date(Date.UTC(1899,11,30)+v*864e5).toISOString().slice(0,10); }
  const m=(''+v).match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  if(m) return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
  const m2=(''+v).match(/(\d{4})-(\d{2})-(\d{2})/); return m2? m2[0] : null; };
const code=v=>(''+v).replace(/[\s ,]/g,'').trim();

const bySup={}, rows=[]; const etas=new Set(), mades=new Set();
for(let i=hr+1;i<A.length;i++){ const r=A[i]||[];
  const s=code(r[iCode]); if(!s||!/^\d+$/.test(s)) continue;
  const q=Math.round(+(''+r[iQty]).replace(/[\s ,]/g,'')||0);
  if(q<=0) continue;
  const e=iEta>=0? iso(r[iEta]) : null, md=iMade>=0? iso(r[iMade]) : null;
  if(e) etas.add(e); if(md) mades.add(md);
  bySup[s]=(bySup[s]||0)+q;
  rows.push({sup:s, qty:q, eta:e, name:iName>=0? (''+r[iName]).trim():'', art:iArt>=0?(''+r[iArt]).trim():''});
}
if(!rows.length){ console.error('в файле не найдено ни одной строки с кодом и количеством'); process.exit(1); }
const total=Object.values(bySup).reduce((s,v)=>s+v,0);

// срок прихода: один на всю партию, либо свои даты по кодам
const etaList=[...etas].sort();
const eta = etaList.length? etaList[0] : null;
const etaBySup={}; if(etaList.length>1) rows.forEach(r=>{ if(r.eta && r.eta!==eta) etaBySup[r.sup]=r.eta; });
const saleArg=flag('sale');
const addDays=(d,n)=>new Date(new Date(d+'T00:00:00Z').getTime()+n*864e5).toISOString().slice(0,10);
const etaSale = saleArg || (eta? addDays(eta,SALE_LAG) : null);
const etaSaleBySup={}; Object.entries(etaBySup).forEach(([s,d])=>etaSaleBySup[s]=addDays(d,SALE_LAG));

// ключ партии
let key=flag('key');
if(!key){ let n=2; while(RD.inbound['order'+n]) n++; key=RD.inbound.order? 'order'+n : 'order'; }
const label=flag('label') || ('Заказано производству'+(eta? ' (приход '+eta.split('-').reverse().join('.')+')':''));

// ---------- сверка с каталогом
const S=v=>(''+(v==null?'':v)).trim();
const catBy={}; (RD.catalog||[]).forEach(c=>{ const s=S(c.supplierCode); if(s) (catBy[s]||(catBy[s]=[])).push(c); });
const unknown=Object.keys(bySup).filter(s=>!catBy[s]);
const grp={}; Object.keys(bySup).forEach(s=>{ const c=(catBy[s]||[])[0];
  const g=c? (S(c.adGroup)||S(c.category)||'(без группы)') : 'НЕТ В КАТАЛОГЕ'; grp[g]=(grp[g]||0)+bySup[s]; });

// ---------- что уже было
const others=Object.keys(RD.inbound).filter(k=>k!==key && isOrderKey(k));
const dupe=[]; others.forEach(k=>{ const b=RD.inbound[k].bySup||{};
  Object.keys(bySup).forEach(s=>{ if(b[s]) dupe.push({key:k,sup:s,was:b[s],now:bySup[s]}); }); });

const replaced=RD.inbound[key]? (RD.inbound[key].total||0) : 0;
RD.inbound[key]={date:today, total, label, bySup, eta, etaSale,
  ...(Object.keys(etaBySup).length? {etaBySup}:{}), ...(Object.keys(etaSaleBySup).length? {etaSaleBySup}:{}),
  src:path.basename(file)};
save();

console.log('ПАРТИЯ ['+key+'] '+(replaced? '— ЗАМЕНЕНА (было '+F(replaced)+' шт)':'— заведена'));
console.log('  файл: '+path.basename(file)+' · лист «'+sheet+'» · строк '+rows.length);
console.log('  ВСЕГО '+F(total)+' шт по '+Object.keys(bySup).length+' кодам');
if(mades.size) console.log('  срок изготовления: '+[...mades].sort().join(', '));
console.log('  ПРИХОД НА СКЛАД:  '+(eta||'не указан в файле')+(eta? ' (через '+days(today,eta)+' дн)':'')
  +(Object.keys(etaBySup).length? ' · свои даты у '+Object.keys(etaBySup).length+' кодов':''));
console.log('  ВЫХОД В ПРОДАЖУ: '+(etaSale||'не задан')
  +(saleArg? ' (задан вручную)' : eta? ' ← ПОСТАВЛЕНА АВТОМАТОМ, приход + '+SALE_LAG+' дн на приёмку и отгрузку.'
     +'\n                    Если срок другой: node scripts/set-eta.cjs '+key+' --sale ГГГГ-ММ-ДД' : ''));

console.log('\nПО ГРУППАМ:');
Object.entries(grp).sort((a,b)=>b[1]-a[1]).forEach(([g,q])=>console.log('  '+g+': '+F(q)+' шт'));

if(unknown.length){ console.log('\n⚠ КОДОВ НЕТ В КАТАЛОГЕ ВБ ('+unknown.length+') — проверьте, не опечатка ли:');
  unknown.forEach(s=>{ const r=rows.find(x=>x.sup===s);
    console.log('   '+s+' · '+F(bySup[s])+' шт · '+(r?r.name:'')); }); }

if(dupe.length){ console.log('\nЭТИ КОДЫ ЕСТЬ И В ДРУГИХ ПАРТИЯХ — это НОРМА, если партии разные:');
  const byK={}; dupe.forEach(d=>(byK[d.key]||(byK[d.key]=[])).push(d));
  Object.entries(byK).forEach(([k,list])=>{
    const b=RD.inbound[k];
    console.log('  ['+k+'] '+(b.label||k)+' — приход '+(b.eta||'?')+': '+list.length+' общих кодов, '
      +F(list.reduce((s,d)=>s+d.was,0))+' шт там против '+F(list.reduce((s,d)=>s+d.now,0))+' шт здесь');
  });
  console.log('  Если это НЕ дополнительная партия, а исправленная версия старой —');
  console.log('  уберите старую: node scripts/prod-order.cjs drop <ключ>'); }

const allOrd=Object.keys(RD.inbound).filter(isOrderKey);
console.log('\nИТОГО ЗАКАЗАНО ПРОИЗВОДСТВУ по всем партиям: '
  +F(allOrd.reduce((s,k)=>s+(RD.inbound[k].total||0),0))+' шт ('+allOrd.length+' партии)');
console.log('\nДальше: node scripts/encrypt.cjs <код>');
