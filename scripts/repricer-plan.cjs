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
// ВБ: план = цель заказов «Запаса и темпа» (`targetOrders` из srDecorate: (ВБ FBO + свои склады − недостача Ozon) ÷ дней
//     до партии ÷ % выкупа ВБ), целое, 10…30 — те же рамки, что у Ozon (продавец: «в целом одно и то же получается»).
//
// Цифры берём С САЙТА (srExtend(srDecorate(srRows())) — «Запас и темп»), чтобы база, партии и % выкупа были те же:
//   ВБ заберёт со складов = max(0, min(продажи ВБ/дн × дней до партии − (ВБ FBO + отгрузки в пути на ВБ), свои склады))
//   база Ozon = остаток Ozon (склады + в пути, вкл. «Ozon СФО/ЦФО») + (свои склады − что заберёт ВБ)
//   план = база ÷ дней до партии ÷ % выкупа Ozon по товару (7 дн; нет продаж — по замеру окна, иначе общий)
//   → округлить до целого, рамки 10…30 (продавец). Дней до партии — `hz` сайта (выход партии в продажу; нет — 180).
// СЕЗОН НЕ ПРИМЕНЯЕМ сознательно: репрайсер держит ОДНО число заказов в день, в пик он просто держит цену выше;
// с весами ЗАП-05 к партии осталось бы ~25% товара. (План ВБ на «Запасе и темпе» считается с сезоном — это разное.)
'use strict';
const fs=require('fs'), path=require('path'), cp=require('child_process'), zlib=require('zlib');
const XLSX=require('./node_modules/xlsx');
const { chromium }=require('./node_modules/playwright-core');
const ROOT=path.join(__dirname,'..');
const [src, outDir=process.cwd()]=process.argv.slice(2);
const CODE=process.env.VERIFY_CODE;
if(!src||!CODE){ console.error('usage: VERIFY_CODE=… node scripts/repricer-plan.cjs <выгрузка.xlsx> [папка]'); process.exit(1); }
const MIN=10, MAX=30, PORT=+(process.env.PORT||8791);

async function dump(){
  const srv=cp.spawn('python3',['-m','http.server',String(PORT),'--bind','127.0.0.1'],{cwd:ROOT,stdio:'ignore'});
  await new Promise(r=>setTimeout(r,1000));
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
  try{
    const p=await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e.message)));
    await p.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'load'});
    await p.fill('#lockInput',CODE); await p.click('.lock-btn');
    await p.waitForFunction(()=>typeof FINANCE_CACHE!=='undefined'&&FINANCE_CACHE.length>0&&typeof srRows==='function'&&OZDATA,null,{timeout:120000});
    await p.waitForTimeout(1500);
    const d=await p.evaluate(()=>({
      rows:srExtend(srDecorate(srRows())).map(r=>({sup:r.sup,name:r.name,hz:r.hz,hzSrc:r.hzSrc,stockOz:r.stockOz,stockWb:r.stockWb,
        wbShip:r.wbShip,whQty:r.whQty,spdWb:r.spdWb,ordWb:r.ordWb,ordOz:r.ordOz,spdOz:r.spdOz,
        targetOrders:r.targetOrders,wbAvail:r.wbAvail,ozTake:r.ozTake,boWb:r.boWb})),
      bo:(RD.ozon&&RD.ozon.meta&&RD.ozon.meta.buyoutWin)||null}));
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
  if(!MP||iPlan<0) throw new Error('не понял файл: нужна колонка OrdersPlanQty и OfferId (Ozon) или SupplierArticle (ВБ): '+H.join(' | '));
  const iOff=H.findIndex(h=>MP==='ozon'? /OfferId/.test(h) : /SupplierArticle/.test(h));
  const iName=H.findIndex(h=>MP==='ozon'? /\(Name\)/.test(h) : /SupplierProductId/.test(h));
  const iNm=H.findIndex(h=>/\(SupSku\)/.test(h));
  const MPN=MP==='ozon'? 'Ozon' : 'ВБ';
  if(MP==='wb'){ const seen={}; for(let i=1;i<A.length;i++){ const s=''+A[i][iOff]; if(!s) continue; if(seen[s]) throw new Error('у кода '+s+' несколько карточек ВБ — план кода надо делить, скрипт этого не умеет'); seen[s]=1; } }
  const colL=XLSX.utils.encode_col(iPlan);
  const res=[];
  for(let i=1;i<A.length;i++){ const row=A[i]; if(row[iOff]==='') continue;
    const sup=''+row[iOff], r=by[sup], xr=i+1;
    if(!r){ res.push({xr,sup,nm:iNm>=0?row[iNm]:'',name:row[iName],J:MIN,was:row[iPlan],why:'нет в данных дашборда — поставлен минимум'}); continue; }
    if(MP==='wb'){
      const raw=r.targetOrders==null? 0 : r.targetOrders, J=Math.min(MAX,Math.max(MIN,Math.round(raw)));
      res.push({xr,sup,nm:row[iNm],name:r.name||row[iName],J,raw,was:row[iPlan],ordNow:r.ordWb||0,stockWb:(r.stockWb||0),wh:r.whQty||0,
        ozTake:r.ozTake||0,base:r.wbAvail||0,hz:r.hz,hzSrc:r.hzSrc,bo:r.boWb,
        note: raw>MAX? 'товара больше, чем уйдёт при 30/дн — к партии останется' : (r.wbAvail||0)<=0? 'товара для ВБ нет — минимум для формы'
          : Math.round(raw)<MIN? 'товара мало: даже при 10/дн кончится раньше партии' : ''});
      continue;
    }
    const hz=r.hz||180, wbOwn=(r.stockWb||0)+(r.wbShip||0);
    const wbTake=Math.max(0,Math.min((r.spdWb||0)*hz-wbOwn, r.whQty||0));
    const base=(r.stockOz||0)+Math.max(0,(r.whQty||0)-wbTake);
    const bo=(r.ordOz>0&&r.spdOz>0)? r.spdOz/r.ordOz : (boBy[sup]||boAll);
    const raw=base/hz/bo, J=Math.min(MAX,Math.max(MIN,Math.round(raw)));
    res.push({xr,sup,name:r.name||row[iName],J,raw,ordNow:r.ordOz||0,stockOz:r.stockOz||0,wh:r.whQty||0,wbTake,base,hz,hzSrc:r.hzSrc,bo,
      note: raw>MAX? 'товара больше, чем уйдёт при 30/дн — к партии останется' : base<=0? 'товара нет — минимум для формы'
        : Math.round(raw)<MIN? 'товара мало: даже при 10/дн кончится раньше партии' : ''});
  }
  // правка XML первого листа (sheet1.xml — «Отчет»; проверка чтения ниже): только ячейки колонки плана, остальное байт в байт
  const JSZipLess=require('./node_modules/xlsx').CFB; // CFB умеет zip: читаем/пишем архив без пересборки книги
  const z=JSZipLess.read(fs.readFileSync(src),{type:'buffer'});
  const ent=JSZipLess.find(z,'/xl/worksheets/sheet1.xml'); let xml=Buffer.from(ent.content).toString('utf8');
  for(const x of res){
    const cell=new RegExp(`<c r="${colL}${x.xr}"([^>]*?)(?: t="s")?(?:/>|>(?:<v>[^<]*</v>)?</c>)`);
    const m=xml.match(cell);
    if(m){ const st=(m[1].match(/ s="\d+"/)||[''])[0]; xml=xml.replace(cell,`<c r="${colL}${x.xr}"${st}><v>${x.J}</v></c>`); continue; }
    const prev=new RegExp(`(<row r="${x.xr}"[^>]*>(?:(?!</row>).)*?<c r="${XLSX.utils.encode_col(iPlan-1)}${x.xr}"[^>]*>.*?</c>)`);
    const pm=xml.match(prev); if(!pm) throw new Error('не нашёл строку '+x.xr);
    xml=xml.replace(prev,`$1<c r="${colL}${x.xr}"><v>${x.J}</v></c>`);
  }
  ent.content=Buffer.from(xml,'utf8');
  const dt=new Date().toISOString().slice(0,10).split('-').reverse().join('.');
  const out=path.join(outDir,`${MPN}_план_заказов_${dt}.xlsx`);
  fs.writeFileSync(out, JSZipLess.write(z,{type:'buffer',fileType:'zip',compression:true}));
  // проверка: файл читается, все строки заполнены целыми 10…30
  const chk=XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets[wb.SheetNames[0]],{header:1,defval:''}).slice(1).filter(r=>r[iOff]!=='');
  const bad=chk.filter(r=>!Number.isInteger(r[iPlan])||r[iPlan]<MIN||r[iPlan]>MAX);
  if(bad.length) throw new Error('незаполненные/кривые строки: '+bad.map(r=>r[iOff]).join(', '));
  const r1=v=>v==null?null:Math.round(v*10)/10, r0=v=>v==null?null:Math.round(v);
  const rep=MP==='wb'? res.map(x=>({'Арт. поставщика (код 1С)':+x.sup,'Артикул ВБ':x.nm,'Товар':x.name,'План, заказов/дн':x.J,'Было в файле':x.was,
      'До округления':r1(x.raw),'Сейчас заказов/дн (7 дн)':r1(x.ordNow),'ВБ FBO':x.stockWb??null,'Свои склады':x.wh??null,
      'Заберёт Ozon до партии':r0(x.ozTake),'База ВБ':r0(x.base),'Дней до партии':x.hz??null,'Срок':x.hzSrc||'','% выкупа ВБ':x.bo==null?null:Math.round(x.bo*1000)/10,'Пометка':x.why||x.note}))
    : res.map(x=>({'Артикул Ozon':+x.sup,'Товар':x.name,'План, заказов/дн':x.J,'До округления':r1(x.raw),
    'Сейчас заказов/дн (7 дн)':r1(x.ordNow),'Ozon + в пути':x.stockOz??null,'Свои склады':x.wh??null,
    'Заберёт ВБ до партии':r0(x.wbTake),'База Ozon':r0(x.base),'Дней до партии':x.hz??null,
    'Срок':x.hzSrc||'', '% выкупа Ozon':x.bo==null?null:Math.round(x.bo*1000)/10,'Пометка':x.why||x.note}));
  rep.sort((a,b)=>(b['Сейчас заказов/дн (7 дн)']||0)-(a['Сейчас заказов/дн (7 дн)']||0));
  const how=MP==='wb'? [['Как считается план заказов ВБ'],[''],['База ВБ = склады ВБ (FBO) + свои склады − что со своих складов заберёт Ozon до партии'],
    ['Ozon заберёт = его продажи в день × дней до партии − его остаток и в пути (не больше своих складов)'],
    ['План = база ÷ дней до партии ÷ % выкупа ВБ по товару; целое, от 10 до 30 — то же, что цель на «Запасе и темпе»'],
    ['Дней до партии — до выхода ближайшей партии в продажу по файлу заказов; партии нет — 180'],
    ['Сезон не применён: репрайсер держит одно число заказов в день, в пик просто удержит цену выше']] : [['Как считается план заказов Ozon'],[''],['База Ozon = остаток Ozon (склады + в пути) + свои склады − что со своих складов заберёт ВБ до партии'],
    ['ВБ заберёт = его продажи в день × дней до партии − его остаток FBO и в пути (не больше своих складов)'],
    ['План = база ÷ дней до партии ÷ % выкупа Ozon по товару; целое, от 10 до 30'],
    ['Дней до партии — до выхода ближайшей партии в продажу по файлу заказов; партии нет — 180'],
    ['Сезон не применён: репрайсер держит одно число заказов в день, в пик просто удержит цену выше']];
  const W=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(W,XLSX.utils.json_to_sheet(rep),'Разбор'); XLSX.utils.book_append_sheet(W,XLSX.utils.aoa_to_sheet(how),'Как считается');
  const out2=path.join(outDir,`${MPN}_план_заказов_разбор_${dt}.xlsx`); XLSX.writeFile(W,out2);
  const cnt={}; res.forEach(x=>cnt[x.J]=(cnt[x.J]||0)+1);
  console.log(`строк ${res.length} · заполнено ${chk.length} · по значениям ${JSON.stringify(cnt)}`);
  console.log(`${MPN}: упёрлись в 30 (товара с запасом): ${res.filter(x=>x.raw>MAX).length} · в 10 при товаре, которого мало: ${res.filter(x=>Math.round(x.raw)<MIN&&x.base>0).length} · без товара/данных: ${res.filter(x=>x.why||!(x.base>0)).length}`);
  console.log('→ '+out+'\n→ '+out2);
})().catch(e=>{ console.error(e.message||e); process.exit(1); });
