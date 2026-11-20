// План заказов в день для репрайсера — Ozon (ЗАП-17) и ВБ (ЗАП-18), 06.11.2026: заполняет колонку
// «План зак(аз), шт (OrdersPlanQty)» в выгрузке репрайсера. Площадку узнаёт по колонкам:
//   Ozon — «Артикул Ozon (OfferId)» («Ozon. Отчет для базового расширения_ план заказов…xlsx»);
//   ВБ   — «Арт. поставщика (SupplierArticle)» («report-….xlsx», по карточке; у кода одна карточка — иначе стоп).
//
// Запуск (из корня репозитория, код — только из окружения):
//   VERIFY_CODE=… node scripts/repricer-plan.cjs <выгрузка.xlsx> [папка_для_результата]
// Пишет две книги: <папка>/<ВБ|Ozon>_план_заказов_ДД.ММ.ГГГГ.xlsx — исходный файл, где заполнена ТОЛЬКО колонка плана
// (правка XML первого листа, оформление, остальные колонки и листы не тронуты), и …_разбор_….xlsx — откуда взялось число.
//
// С 18.11.2026 (ЗАП-22) — ИНДИВИДУАЛЬНО ПО ТОВАРУ, БЕЗ РАМКИ 10…30 (продавец: «рамка плана будет индивидуально по каждому товару и всё,
// убираем ограничения»): целое, не меньше 1. Цель — товар и все партии на 180 дней: не кончиться до прихода каждой партии и дожить
// до 180 дней со всеми партиями (их доля маркетплейсов — PROD_MP_SHARE сайта, 65%); берётся самое жёсткое условие. Маржа площадки
// маржу держит минимальная цена репрайсера; маржа после рекламы ниже 10% — только пометка (ЗАП-24, исправлено 18.11).
// Сезона нет нигде (ЗАП-22). Нет товара в данных дашборда — 10, как раньше.
//
// ВБ: план = `planRep` сайта (srDecorate: цель заказов «Запаса и темпа» с теми же правилами) — одно число на сайте и в файле.
// Ozon (ЗАП-26 — приоритет Ozon): база Ozon = остаток Ozon (склады + в пути, вкл. «Ozon СФО/ЦФО») + свои склады (+ партии), ВБ не вычитаем;
//   (ВБ заберёт = max(0, min(продажи ВБ/дн × дней − (ВБ FBO + отгрузки в пути на ВБ), свои склады + партии)));
//   план = база ÷ дней ÷ % выкупа Ozon по товару (7 дн; нет продаж — по замеру окна, иначе общий), по тем же условиям 180 дн.
'use strict';
const fs=require('fs'), path=require('path'), cp=require('child_process'), zlib=require('zlib');
const XLSX=require('./node_modules/xlsx');
const { chromium }=require('./node_modules/playwright-core');
const ROOT=path.join(__dirname,'..');
const [src, outDir=process.cwd()]=process.argv.slice(2);
const CODE=process.env.VERIFY_CODE;
if(!src||!CODE){ console.error('usage: VERIFY_CODE=… node scripts/repricer-plan.cjs <выгрузка.xlsx> [папка]'); process.exit(1); }
const NEW_MIN=15;   // ЗАП-27: стартовый план новинки (как NEW_PLAN_MIN сайта)
const NODATA=10, PORT=+(process.env.PORT||8791);   // нет товара в данных дашборда — 10, как раньше

async function dump(){
  const srv=cp.spawn('python3',['-m','http.server',String(PORT),'--bind','127.0.0.1'],{cwd:ROOT,stdio:'ignore'});
  await new Promise(r=>setTimeout(r,1000));
  const b=await chromium.launch({executablePath:(process.env.PW_CHROME||'/opt/pw-browsers/chromium'),args:['--no-sandbox']});
  try{
    const p=await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e.message)));
    await p.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'load'});
    await p.fill('#lockInput',CODE); await p.click('.lock-btn');
    await p.waitForFunction(()=>typeof FINANCE_CACHE!=='undefined'&&FINANCE_CACHE.length>0&&typeof srRows==='function'&&OZDATA,null,{timeout:120000});
    await p.waitForTimeout(1500);
    const d=await p.evaluate(()=>({
      rows:srExtend(srDecorate(srRows())).map(r=>({sup:r.sup,name:r.name,hz:r.hz,hzSrc:r.hzSrc,stockOz:r.stockOz,stockWb:r.stockWb,
        wbShip:r.wbShip,whQty:r.whQty,spdWb:r.spdWb,ordWb:r.ordWb,ordOz:r.ordOz,spdOz:r.spdOz,
        targetOrders:r.targetOrders,wbAvail:r.wbAvail,ozTake:r.ozTake,boWb:r.boWb,planRep:r.planRep,planNote:r.planNote||'',isNew:!!r.isNew,isNewOz:!!r.isNewOz,tgtSrc:r.tgtSrc||'',
        supplies:r.supplies||[],wbTr:r.wbTr||0,stockWbOnly:r.stockWb||0,mgWb:r.mgWb||null})),
      mpShare:PROD_MP_SHARE, planHz:PLAN_HZ, mgMin:REC_MARGIN_MIN, mgRevMin:SR_MG_REV_MIN,
      ozMg:(()=>{ const ds=((OZDATA&&OZDATA.dates)||[]).slice(-7), set=new Set(ds), m={};
        try{ ozFinRows().filter(x=>set.has(x.date)).forEach(x=>{ const e=m[x.sku]||(m[x.sku]={rev:0,profit:0,ad:0}); e.rev+=x.revenue||0; e.profit+=x.profit||0; e.ad+=x.ad||0; }); }catch(e){}
        Object.values(m).forEach(e=>{ e.margin=e.rev>0? e.profit/e.rev : 0; e.preAd=e.rev>0? (e.profit+e.ad)/e.rev : 0; }); return m; })(),
      bo:(RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutWin)||null,
      ozCodes:((RD.ozon&&RD.ozon.catalog)||[]).map(c=>""+c.sku),
      outSups:[...recOutSups()].map(String)}));
    if(errs.length) throw new Error('ошибки на сайте: '+errs.join(' | '));
    return d;
  } finally { await b.close(); srv.kill(); }
}

(async()=>{
  const D=await dump();
  const hist=(D.bo&&D.bo.history)||[], lastBo=hist[hist.length-1]||{}, boAll=lastBo.all||0.8, boBy=lastBo.bySku||{};
  const by={}; D.rows.forEach(r=>by[r.sup]=r);
  const wb=XLSX.readFile(src); const sh=wb.Sheets[wb.SheetNames[0]];
  const A=XLSX.utils.sheet_to_json(sh,{header:1,defval:''});
  const H=A[0], iPlan=H.findIndex(h=>/OrdersPlanQty/.test(h));
  const MP=H.some(h=>/OfferId/.test(h))? 'ozon' : H.some(h=>/SupplierArticle/.test(h))? 'wb' : null;
  if(!MP) throw new Error('не понял файл: нужна колонка OfferId (Ozon) или SupplierArticle (ВБ): '+H.join(' | '));
  /* В выгрузке нет колонки плана (18.11.2026: Ozon прислал обычный «Отчет» настроек — план заказов в нём не задаётся, он в «Отчете для
     базового расширения … план заказов»). Тогда считаем план по кодам файла и пишем ТОЛЬКО разбор — исходник не трогаем. */
  const tableOnly=iPlan<0;
  if(tableOnly) console.log('⚠ В этой выгрузке нет колонки «План зак, шт (OrdersPlanQty)» — файл не меняю, считаю только разбор. Для '+(MP==='ozon'?'Ozon':'ВБ')+' нужна выгрузка с планом заказов («Отчет для базового расширения … план заказов»).');
  const iOff=H.findIndex(h=>MP==='ozon'? /OfferId/.test(h) : /SupplierArticle/.test(h));
  const iName=H.findIndex(h=>MP==='ozon'? /\(Name\)/.test(h) : /SupplierProductId/.test(h));
  const iNm=H.findIndex(h=>/\(SupSku\)/.test(h));
  const MPN=MP==='ozon'? 'Ozon' : 'ВБ';
  if(MP==='wb'){ const seen={}; for(let i=1;i<A.length;i++){ const s=''+A[i][iOff]; if(!s) continue; if(seen[s]) throw new Error('у кода '+s+' несколько карточек ВБ — план кода надо делить, скрипт этого не умеет'); seen[s]=1; } }
  const colL=iPlan>=0? XLSX.utils.encode_col(iPlan) : null;
  const ozSet=new Set(D.ozCodes||[]), outSet=new Set(D.outSups||[]); let skippedForeign=0, skippedOut=0;
  const res=[];
  for(let i=1;i<A.length;i++){ const row=A[i]; if(row[iOff]==='') continue;
    const sup=''+row[iOff], r=by[sup], xr=i+1;
    /* ТОЛЬКО ВАШИ ТОВАРЫ (продавец 10.11.2026: «заполнить только 1 поле и только по моим товарам»). Выгрузка Ozon — весь общий
       кабинет (10.11: 21 781 строка, наших ~200): строку, которой нет в нашем каталоге Ozon, НЕ трогаем вовсе. */
    if(MP==='ozon' && !ozSet.has(sup)){ skippedForeign++; continue; }
    /* «На вывод» без остатка (нигде: Ozon с путём, свои склады) и без плана в файле — не ваш рабочий ассортимент, строку не трогаем
       (10.11: 25 старых кодов 316…/311…/2…). Новинки «в пути» и всё, где план уже стоял, — заполняем. */
    if(MP==='ozon' && (iPlan<0 || row[iPlan]==='') && outSet.has(sup) && (!r || ((r.stockOz||0)+(r.whQty||0))<=0)){ skippedOut++; continue; }
    if(!r){ res.push({xr,sup,nm:iNm>=0?row[iNm]:'',name:row[iName],J:NODATA,was:tableOnly?'':row[iPlan],why:'нет в данных дашборда — 10, как раньше'}); continue; }
    if(MP==='wb'){
      const raw=r.targetOrders==null? null : r.targetOrders, J=r.planRep!=null? r.planRep : NODATA;
      res.push({xr,sup,nm:row[iNm],name:r.name||row[iName],J,raw,was:tableOnly?'':row[iPlan],ordNow:r.ordWb||0,stockWb:(r.stockWb||0),wh:r.whQty||0,
        ozTake:r.ozTake||0,base:r.wbAvail||0,hz:r.hz,hzSrc:r.tgtSrc||r.hzSrc,bo:r.boWb,
        note: (r.isNew && r.planNote ? r.planNote : '') || (r.mgWb && r.mgWb.rev>=(D.mgRevMin||21000) && r.mgWb.margin*100<(D.mgMin||10)? 'маржа ВБ за 7 дн после рекламы '+Math.round(r.mgWb.margin*100)+'%, до рекламы '+Math.round((r.mgWb.preAd||0)*100)+'% — дело в рекламе; цену репрайсер опустит не ниже минимальной' : '') || (r.planRep==null? 'горизонта нет — 10, как раньше' : (r.wbAvail||0)<=0 && !(r.supplies||[]).length? 'товара для ВБ нет' : '')});
      continue;
    }
    /* Формула — scripts/lib/plan-oz.cjs (одна для repricer-plan и plan-review, ЗАП-24). */
    const bo=(r.ordOz>0&&r.spdOz>0)? r.spdOz/r.ordOz : (boBy[sup]||boAll);
    const P=require('./lib/plan-oz.cjs').planOz(r,{share:D.mpShare,H:D.planHz||180,bo,nodata:NODATA});
    let J=P.J; const raw=P.raw, bb={base:P.base,take:P.take}, hzTxt=P.noGoods? 'товара нет' : P.src, bind=P.bind, H=D.planHz||180;
    let note=P.noGoods? 'товара нет — 10, как раньше' : '';
    /* ЗАП-27/28 (20.11.2026): новинка НА OZON (заказов на Ozon не было или первый — не раньше 30 дн) — план не ниже 15 (сайт: srIsNew(sup,'ozon')). */
    if(r.isNewOz && J<NEW_MIN){ J=NEW_MIN; note='новинка — старт '+NEW_MIN+' (ЗАП-27)'; }
    const mg=(D.ozMg||{})[sup];
    /* ЗАП-24: план по марже НЕ подменяем — порог держит минимальная цена репрайсера; низкая маржа после рекламы — только пометка. */
    if(!P.noGoods && mg && mg.rev>=(D.mgRevMin||21000) && mg.margin*100<(D.mgMin||10)) note='маржа Ozon за 7 дн после рекламы '+Math.round(mg.margin*100)+'%, до рекламы '+Math.round((mg.preAd||0)*100)+'% — дело в рекламе; цену репрайсер опустит не ниже минимальной';
    res.push({xr,sup,name:r.name||row[iName],J,raw,ordNow:r.ordOz||0,stockOz:r.stockOz||0,wh:r.whQty||0,wbTake:bb?bb.take:0,base:bb?bb.base:0,hz:bind?bind.t:H,hzSrc:hzTxt,bo,
      note: note || ((bb?bb.base:0)<=0? 'товара нет' : '')});
  }
  const dt=new Date().toISOString().slice(0,10).split('-').reverse().join('.');
  let out=null, chk=[], filled=new Set();
  if(!tableOnly){
  // правка XML первого листа (sheet1.xml — «Отчет»; проверка чтения ниже): только ячейки колонки плана, остальное байт в байт
  const JSZipLess=require('./node_modules/xlsx').CFB; // CFB умеет zip: читаем/пишем архив без пересборки книги
  const z=JSZipLess.read(fs.readFileSync(src),{type:'buffer'});
  const ent=JSZipLess.find(z,'/xl/worksheets/sheet1.xml'); let xml=Buffer.from(ent.content).toString('utf8');
  /* ДВА ФОРМАТА ЛИСТА (10.11.2026). Файл, сохранённый Excel, — ячейки с адресами (`<c r="AA2" …>`). Выгрузка прямо из репрайсера —
     с префиксом `x:` и БЕЗ адресов: каждая строка — `<x:row>` со всеми ячейками подряд (пустые — `<x:c t="str"><x:v></x:v></x:c>`).
     Во втором случае меняем ячейку по ПОЗИЦИИ: строка №xr по порядку, ячейка №iPlan в ней. */
  const positional=!/<(?:\w+:)?c\s+r="/.test(xml);
  if(positional){
    const pre=(xml.match(/<(\w+:)?row\b/)||[])[1]||'';
    const rowRe=new RegExp(`<${pre}row\\b[^>]*>[\\s\\S]*?</${pre}row>`,'g');
    const cellRe=new RegExp(`<${pre}c\\b[^>]*?(?:/>|>[\\s\\S]*?</${pre}c>)`,'g');
    const want={}; res.forEach(x=>want[x.xr]=x.J);
    let ri=0;
    xml=xml.replace(rowRe,row=>{ ri++; const J=want[ri]; if(J==null) return row;
      let ci=-1, hit=false;
      const out=row.replace(cellRe,c=>{ ci++; if(ci!==iPlan) return c; hit=true; return `<${pre}c t="n"><${pre}v>${J}</${pre}v></${pre}c>`; });
      if(!hit) throw new Error('в строке '+ri+' нет ячейки №'+(iPlan+1)+' — формат файла другой');
      return out; });
  }
  for(const x of (positional? [] : res)){
    const cell=new RegExp(`<c r="${colL}${x.xr}"([^>]*?)(?: t="s")?(?:/>|>(?:<v>[^<]*</v>)?</c>)`);
    const m=xml.match(cell);
    if(m){ const st=(m[1].match(/ s="\d+"/)||[''])[0]; xml=xml.replace(cell,`<c r="${colL}${x.xr}"${st}><v>${x.J}</v></c>`); continue; }
    const prev=new RegExp(`(<row r="${x.xr}"[^>]*>(?:(?!</row>).)*?<c r="${XLSX.utils.encode_col(iPlan-1)}${x.xr}"[^>]*>.*?</c>)`);
    const pm=xml.match(prev); if(!pm) throw new Error('не нашёл строку '+x.xr);
    xml=xml.replace(prev,`$1<c r="${colL}${x.xr}"><v>${x.J}</v></c>`);
  }
  ent.content=Buffer.from(xml,'utf8');
  out=path.join(outDir,`${MPN}_план_заказов_${dt}.xlsx`);
  fs.writeFileSync(out, JSZipLess.write(z,{type:'buffer',fileType:'zip',compression:true}));
  // проверка: файл читается, все строки заполнены целыми ≥ 1
  chk=XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets[wb.SheetNames[0]],{header:1,defval:''}).slice(1);   // индекс k ↔ строка Excel k+2
  filled=new Set(res.map(x=>x.xr));
  const bad=chk.filter((r,k)=>filled.has(k+2) && (!Number.isInteger(r[iPlan])||r[iPlan]<1));
  if(bad.length) throw new Error('незаполненные/кривые строки: '+bad.map(r=>r[iOff]).join(', '));
  }
  const r1=v=>v==null?null:Math.round(v*10)/10, r0=v=>v==null?null:Math.round(v);
  const rep=MP==='wb'? res.map(x=>({'Арт. поставщика (код 1С)':+x.sup,'Артикул ВБ':x.nm,'Товар':x.name,'План, заказов/дн':x.J,'Было в файле':x.was,
      'До округления':r1(x.raw),'Сейчас заказов/дн (7 дн)':r1(x.ordNow),'ВБ FBO':x.stockWb??null,'Свои склады':x.wh??null,
      'Заберёт Ozon до партии':r0(x.ozTake),'База ВБ':r0(x.base),'Дней до партии':x.hz??null,'Срок':x.hzSrc||'','% выкупа ВБ':x.bo==null?null:Math.round(x.bo*1000)/10,'Пометка':x.why||x.note}))
    : res.map(x=>({'Артикул Ozon':+x.sup,'Товар':x.name,'План, заказов/дн':x.J,'До округления':r1(x.raw),
    'Сейчас заказов/дн (7 дн)':r1(x.ordNow),'Ozon + в пути':x.stockOz??null,'Свои склады':x.wh??null,
    'Заберёт ВБ до партии':r0(x.wbTake),'База Ozon':r0(x.base),'Дней до партии':x.hz??null,
    'Срок':x.hzSrc||'', '% выкупа Ozon':x.bo==null?null:Math.round(x.bo*1000)/10,'Пометка':x.why||x.note}));
  rep.sort((a,b)=>(b['Сейчас заказов/дн (7 дн)']||0)-(a['Сейчас заказов/дн (7 дн)']||0));
  const how=MP==='wb'? [['Как считается план заказов ВБ (ЗАП-22, с 18.11.2026)'],[''],
    ['Товар для ВБ = склады ВБ (FBO) + отгрузки на ВБ в пути + свои склады − что со своих складов заберёт Ozon'],
    ['Партии из Китая идут маркетплейсам долей 65% (30–40% — розница); Ozon добирает со складов и партий свою недостачу'],
    ['Цель продаж в день — самое жёсткое из условий: не кончиться до прихода каждой партии и дожить до 180 дней со всеми партиями'],
    ['План = цель ÷ % выкупа ВБ по товару, целое, не меньше 1, без рамки — то же число, что «в репрайсер» на «Запасе и темпе»'],
    ['Ниже минимальной цены репрайсер не опустит — она держит маржу; маржа после рекламы ниже 10% — только пометка (дело в рекламе)'],
    ['Сезон не учитывается (решение 18.11.2026); нет товара в данных дашборда — 10']]
  : [['Как считается план заказов Ozon (ЗАП-22, с 18.11.2026)'],[''],
    ['Товар для Ozon = остаток Ozon (склады + в пути, вкл. «Ozon СФО/ЦФО») + свои склады − что со своих складов заберёт ВБ'],
    ['ВБ заберёт = его продажи в день × дней − его остаток FBO и в пути (не больше своих складов); партии — долей 65%'],
    ['Цель продаж в день — самое жёсткое из условий: не кончиться до прихода каждой партии и дожить до 180 дней со всеми партиями'],
    ['План = цель ÷ % выкупа Ozon по товару, целое, не меньше 1, без рамки'],
    ['Ниже минимальной цены репрайсер не опустит — она держит маржу; маржа после рекламы ниже 10% — только пометка (дело в рекламе)'],
    ['Сезон не учитывается (решение 18.11.2026); нет товара в данных дашборда — 10']];
  const W=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(W,XLSX.utils.json_to_sheet(rep),'Разбор'); XLSX.utils.book_append_sheet(W,XLSX.utils.aoa_to_sheet(how),'Как считается');
  const out2=path.join(outDir,`${MPN}_план_заказов_разбор_${dt}.xlsx`); XLSX.writeFile(W,out2);
  const cnt={}; res.forEach(x=>cnt[x.J]=(cnt[x.J]||0)+1);
  console.log(`строк заполнено ${res.length}${skippedForeign? ' · чужих строк не тронуто '+skippedForeign : ''}${skippedOut? ' · «на вывод» без остатка не тронуто '+skippedOut : ''} (проверено чтением: ${chk.filter((r,k)=>filled.has(k+2)).length}) · по значениям ${JSON.stringify(cnt)}`);
  console.log(`${MPN}: план ≥ 30: ${res.filter(x=>x.J>=30).length} · 10–29: ${res.filter(x=>x.J>=10&&x.J<30).length} · 2–9: ${res.filter(x=>x.J>=2&&x.J<10).length} · 1: ${res.filter(x=>x.J===1).length} · маржа после рекламы ниже 10% (пометка, план не меняли): ${res.filter(x=>/маржа/.test(x.note||'')).length} · нет в данных: ${res.filter(x=>x.why).length}`);
  console.log((out? '→ '+out+'\n' : '')+'→ '+out2);
})().catch(e=>{ console.error(e.message||e); process.exit(1); });
