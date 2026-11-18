// КИТАЙ, шаг 5 (ЗАП-21): файл сверки для продавца — итог, все товары МП, что изменилось с прошлой загрузки, даты под вопросом,
// нестыковки 1С (колонка H пустая, а в названии «WB» / есть карточка). Ничего не меняет.
//   node scripts/china/report.cjs <папка> --date ГГГГ-ММ-ДД   → <папка>/out/china/Китай_и_склад_сверка_<дата>.xlsx
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');const B=process.argv[2],ROOT=path.join(__dirname,'..','..');const X=require(ROOT+'/scripts/node_modules/xlsx');
const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:null;};const DATE=arg('--date')||new Date().toISOString().slice(0,10);
const load=f=>{const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(f,'utf8')+'\nglobalThis.__RD=REAL_DATA;',c);return c.__RD;};
const RD=load(ROOT+'/decrypted/wb-data.js'), OLD=load(B+'/bak-wb-data.js');
const ved=JSON.parse(fs.readFileSync(B+'/in-ved/items.json','utf8'));const {log}=JSON.parse(fs.readFileSync(B+'/out/china/build.json','utf8'));
const dmy=i=>i?i.slice(8,10)+'.'+i.slice(5,7)+'.'+i.slice(0,4):'';
const OUR0=require(ROOT+'/scripts/lib/our-codes.cjs')(OLD);
const wb={};RD.catalog.forEach(c=>{const s=(''+(c.supplierCode||'')).trim();(wb[s]=wb[s]||[]).push(c);});const oz={};(RD.ozon.catalog||[]).forEach(c=>oz[''+c.sku]=c);
const cost=c=>{const w=(wb[c]||[]).find(x=>x.costPrice!=null);if(w)return w.costPrice;const m=(RD.meta.costBySup||{})[c];return m&&m.cost?m.cost:'';};
const rowsBy={};RD.prodOrders.rows.forEach(r=>(rowsBy[r.sup]=rowsBy[r.sup]||[]).push(r));
const oldBy={};OLD.prodOrders.rows.forEach(r=>(oldBy[r.sup]=oldBy[r.sup]||[]).push(r));
const arr18={};(log.arrived18||[]).forEach(a=>arr18[a.code]=a.qty);
const mp=ved.filter(x=>x.h);
// лист 2: все товары МП
const T=[['Код 1С','Номенклатура','Направление (кол. H)','Группа 1С','Статус позиции','Свой склад 18.11, своб. шт','Склад в пути Китай (17.11)','В пути до таможни (17.11)','У поставщика в Китае (17.11)','Пришло 18.11 из «в пути»','Едет всего, шт','Ближайшая дата на МП','Шт к этой дате','Без даты (ждём), шт','Было в дашборде до 18.11','Карточка ВБ','Карточка Ozon','Себестоимость']];
mp.forEach(x=>{const rs=rowsBy[x.code]||[];const pend=rs.filter(r=>(r.st==='pending'||r.st==='manual')&&r.mp).sort((a,b)=>a.mp.localeCompare(b.mp));const near=pend[0];
 const nd=rs.filter(r=>r.st==='overdue').reduce((a,r)=>a+r.qty,0);const arrived=arr18[x.code]||0;
 T.push([+x.code,x.name,x.h,x.cat,x.st,(RD.warehouse.bySup[x.code]||{}).qty||0,x.putK-arrived,x.putT,x.sklK,arrived||'',x.putK-arrived+x.putT+x.sklK,near?dmy(near.mp):'',near?pend.filter(r=>r.mp===near.mp).reduce((a,r)=>a+r.qty-(r.got||0),0):'',nd||'',
  OUR0.has(x.code)?'да':'НЕТ — добавлен',(wb[x.code]||[]).map(c=>c.sku).join(', ')||'—',oz[x.code]?(oz[x.code].ozonSku||'есть'):'—',cost(x.code)||'НЕТ']);});
// лист 3: изменения с 27.10 по МП-кодам
const C=[['Код 1С','Номенклатура','Было 27.10: идёт с датой, шт','Было 27.10: «должен был придти», шт','Стало 18.11: в пути, шт','Стало 18.11: у поставщика, шт','Даты на МП сейчас','Что изменилось']];
const codes=[...new Set([...Object.keys(oldBy),...mp.filter(x=>x.putK+x.putT+x.sklK>0).map(x=>x.code)])].filter(c=>{const v=ved.find(y=>y.code===c);return v&&v.h;});
codes.forEach(c=>{const v=ved.find(y=>y.code===c);const o=oldBy[c]||[];const op=o.filter(r=>r.st!=='overdue').reduce((a,r)=>a+r.qty,0),oo=o.filter(r=>r.st==='overdue').reduce((a,r)=>a+r.qty,0);
 const n=rowsBy[c]||[];const tr=n.filter(r=>/пути/.test(r.stage||'')).reduce((a,r)=>a+r.qty,0),sp=n.filter(r=>/поставщ/.test(r.stage||'')).reduce((a,r)=>a+r.qty,0);
 const dates=[...new Set(n.filter(r=>r.mp).map(r=>dmy(r.mp)))].join(', ');
 let what=[];const was=op+oo,now=tr+sp+(n.filter(r=>r.st==='manual').reduce((a,r)=>a+r.qty,0));
 if(!o.length)what.push('новый заказ / новый товар в пути');else if(!n.length)what.push('в Китае ничего нет — партия пришла или снята');else if(now!==was)what.push('количество '+was+' → '+now);
 if(o.some(r=>r.st==='overdue')&&tr>0)what.push('«должен был придти» → сейчас в пути');
 if(arr18[c])what.push('пришло 18.11: '+arr18[c]+' шт');
 if(what.length||o.length===0)C.push([+c,v.name,op||'',oo||'',tr||'',sp||'',dates,what.join('; ')||'без изменений']);});
// лист 4: даты под вопросом
const Q=[['Код 1С','Номенклатура','Шт','Стадия по 1С на 17.11','Дата на МП по правилу','Почему под вопросом']];
log.dateRisk.forEach(r=>Q.push([+r.code,r.name,r.qty,'у поставщика в Китае (не отгружено)',dmy(r.mpDate),'изготовление '+dmy(r.ready)+' + 2 мес = '+dmy(r.mpDate)+', а товар ещё у поставщика — к этой дате на МП не успеет']));
log.transitNoDate.filter(r=>!arr18[r.code]||r.qty>0).forEach(r=>Q.push([+r.code,r.name,r.qty,r.stage,'—','был «должен был уже придти», сейчас в пути — дату на МП назначить']));
// лист 5: нестыковки 1С — колонка H пустая (розница), а в названии «WB» или есть карточка ВБ/Ozon
const N=[['Код 1С','Номенклатура','Что не так','Остаток ВБ','Остаток Ozon','Едет из Китая, шт','Что сделать в 1С']];
const odd=ved.filter(x=>!x.h&&(wb[x.code]||oz[x.code]||/(^|[^A-Za-z])WB([^A-Za-z]|$)/.test(x.name))).map(x=>x.code);
odd.forEach(c=>{const v=ved.find(y=>y.code===c);const w=(wb[c]||[]).reduce((a,x)=>a+(x.wbStock||0),0),o=oz[c]?(oz[c].ozStock||0)+(oz[c].ozTransit||0):0;
 N.push([+c,v.name,'колонка «Артикул для ВБ» пустая (= розница), но в названии «WB» и есть карточка ВБ'+(oz[c]?' и Ozon':''),w,o,v.putK+v.putT+v.sklK,'если товар для маркетплейсов — поставить «WB» или «RF/WB»; пока его партия в дашборд НЕ взята']);});
// лист 1: итог
const sum=(a,f)=>a.reduce((s,x)=>s+f(x),0);
const tot={ost:sum(mp,x=>(RD.warehouse.bySup[x.code]||{}).qty||0),k:sum(mp,x=>x.putK)-sum(log.arrived18||[],a=>a.qty),t:sum(mp,x=>x.putT),s:sum(mp,x=>x.sklK)};
const P=RD.prodOrders.rows;const pend=P.filter(r=>r.mp&&(r.st==='pending'||r.st==='manual'));const byD={};pend.forEach(r=>byD[r.mp]=(byD[r.mp]||0)+r.qty-(r.got||0));
const I=[['Китай и склад: сверка с дашбордом на '+DATE.slice(8,10)+'.'+DATE.slice(5,7)+'.'+DATE.slice(0,4)],[''],
['Товары для маркетплейсов (колонка H: «WB» или «RF/WB»)',mp.length+' кодов (WB '+mp.filter(x=>x.h==='WB').length+', RF/WB '+mp.filter(x=>x.h==='RF/WB').length+')'],
['Розница (колонка H пустая) — не считаем',ved.filter(x=>!x.h).length+' кодов'],[''],
['На своих складах сейчас (ведомость 1С, свободный остаток), шт',tot.ost],
['Склад в пути Китай (по «4 пер.», без уже пришедшего), шт',tot.k],
['В пути до таможни, шт',tot.t],['У поставщика в Китае (заказано, не отгружено), шт',tot.s],['Всего едет из Китая для маркетплейсов, шт',tot.k+tot.t+tot.s],[''],
['ДАТЫ НА МП (правило как в прошлый раз: срок изготовления + 2 месяца)'],
...Object.keys(byD).sort().map(d=>['  на МП '+dmy(d),byD[d]]),
['  без даты — «ждём»: в пути, дата не известна',sum(log.transitNoDate,r=>r.qty)],
['  без даты — «ждём»: у поставщика, срок изготовления прошёл или не указан',sum(log.supplierOverdue,r=>r.qty)+sum(log.supplierExtra,r=>r.qty)],[''],
['ЧЕГО НЕ БЫЛО В ДАШБОРДЕ ДО ЗАГРУЗКИ'],
['  товары МП, которых дашборд не знал',mp.filter(x=>!OUR0.has(x.code)).length+' кодов: '+mp.filter(x=>!OUR0.has(x.code)).map(x=>x.code).join(', ')],
['  из них лежат на твоих складах (свободно), шт',sum(mp.filter(x=>!OUR0.has(x.code)),x=>(RD.warehouse.bySup[x.code]||{}).qty||0)],
['  причина','загрузчик склада считал «нашим» только товар из каталогов; колонку «Артикул для WB» не смотрел — теперь смотрит и сам заносит такие коды'],
['  заказы по ним на ВБ и Ozon','не было (карточки только появились): продажи не потеряны'],[''],
['НУЖЕН ТВОЙ ОТВЕТ'],
['  1. Товар «в пути до таможни» без даты ('+sum(log.transitNoDate,r=>r.qty)+' шт): когда обычно приезжает на МП?','пока считаю «ждём без срока», в запас не беру'],
['  2. '+log.dateRisk.length+' строк ('+sum(log.dateRisk,r=>r.qty)+' шт) с изготовлением 05.10 по 1С ещё у поставщика','по правилу +2 мес. дата 05.12 — успеют? если нет, скажи новую дату'],
['  3. Нестыковки 1С (лист «Нестыковки 1С»)',odd.length+' кодов: '+odd.join(', ')],
['  4. Себестоимость новых кодов','нет у '+mp.filter(x=>!cost(x.code)&&((RD.warehouse.bySup[x.code]||{}).qty||0)>0).length+' кодов с остатком (лист «Товары МП», колонка «Себестоимость» = НЕТ)']];
const wbk=X.utils.book_new();const add=(n,a,w)=>{const s=X.utils.aoa_to_sheet(a);s['!cols']=w.map(x=>({wch:x}));X.utils.book_append_sheet(wbk,s,n);};
add('Итог',I,[70,60]);add('Товары МП',T,[9,50,10,26,10,12,12,12,12,10,12,12,10,12,18,14,14,10]);add('Что изменилось с 27.10',C,[9,50,12,14,12,12,22,60]);add('Даты под вопросом',Q,[9,50,9,30,14,70]);add('Нестыковки 1С',N,[9,50,60,10,10,12,50]);
const f=B+'/out/china/Китай_и_склад_сверка_'+DATE.slice(8,10)+'.'+DATE.slice(5,7)+'.'+DATE.slice(0,4)+'.xlsx';X.writeFile(wbk,f);console.log(f);I.forEach(r=>console.log(r.join(' : ')));console.log('изменений строк:',C.length-1,'| под вопросом:',Q.length-1);
