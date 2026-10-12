// НОВЫЕ КОДЫ 1С ОТ ПРОДАВЦА: список ожидания + автопоиск артикулов в свежих данных.
// Пишет REAL_DATA.meta.newCodes. Дальше: node scripts/encrypt.cjs <код>
//
// ПРАВИЛО ПРОДАВЦА (12.10.2026, дословно): «я тебе буду кидать 6-значный код с пометкой
// новый мой товар, и ты будешь добавлять и на вб и на озон. Схема такая — ты получаешь
// 6-значный код, после этого как только я тебе скидываю какой-либо отчёт, ты уже
// притягиваешь к нему либо артикул вб либо артикул озон, и эти товары спокойно
// встраиваются в панель и по ним идут все возможные расчёты».
//
// ЗАЧЕМ ОТДЕЛЬНОЕ ХРАНИЛИЩЕ, А НЕ ПАМЯТЬ ЧАТА. Между кодом и первым отчётом с артикулом
// проходят дни, а контекст сессии до этого не доживает. Код, названный в переписке и нигде
// не записанный, теряется молча: товар продаётся, а в дашборде его нет — ни в подсорте,
// ни в закупе, ни в прибыли. Поэтому список живёт В СНИМКЕ и проверяется при каждой заливке.
//
// ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ. Это не каталог и не замена `add-catalog-cards.cjs`: пока у кода нет
// ни артикула ВБ, ни артикула Озона, заводить карточку НЕЛЬЗЯ — в подсорте ключ строки это
// код 1С, и пустая карточка без артикула ломает связки. Список — зал ожидания: код лежит
// здесь, пока в отчётах не появится артикул, и только тогда заводится настоящая карточка.
//
// Команды:
//   node scripts/new-codes.cjs list
//   node scripts/new-codes.cjs add "519333, 519334" [--note "толокары Bentley"]
//   node scripts/new-codes.cjs check <файл.xlsx|csv> [ещё файлы…]   ← ищет коды в отчётах
//   node scripts/new-codes.cjs oz <код> <ozonSku> [--name "…"] [--cat "…"]  ← завести карточку Озона
//   node scripts/new-codes.cjs drop "519333"      ← код заведён или отменён
//
// ПОСЛЕ `check`, НАШЕДШЕГО АРТИКУЛ ВБ: завести карточку `add-catalog-cards.cjs`, затем
// `update-ad-tags.cjs` (склейки), `update-cost.cjs` (себестоимость) — и код убрать `drop`.

const fs=require('fs'), vm=require('vm'), path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
let XLSX=null; try{ XLSX=require('./node_modules/xlsx'); }catch(e){ try{ XLSX=require('xlsx'); }catch(e2){} }

const argv=process.argv.slice(2);
const cmd=(argv[0]||'list').toLowerCase();
const arg=n=>{ const i=argv.indexOf('--'+n); return i>=0? argv[i+1] : null; };

const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD; RD.meta=RD.meta||{};
const O=RD.ozon||{};
const today=new Date().toISOString().slice(0,10);

const norm=s=>String(s==null?'':s).replace(/[\s,]/g,'');
const list=(RD.meta.newCodes&&Array.isArray(RD.meta.newCodes.items))
  ? RD.meta.newCodes.items.map(x=>Object.assign({},x)) : [];

// где код уже «прижился»
const wbBySup={}; (RD.catalog||[]).forEach(c=>{const s=norm(c.supplierCode); if(s)(wbBySup[s]||(wbBySup[s]=[])).push(c);});
const ozBy={}; (O.catalog||[]).forEach(c=>ozBy[norm(c.sku)]=c);
function where(code){
  const w=wbBySup[code]||[], o=ozBy[code];
  return {wb:w.length? w.map(c=>c.sku) : null, oz:o? (o.ozonSku||'есть') : null};
}

function save(){
  RD.meta.newCodes={items:list, updatedAt:today,
    note:'Коды 1С, которые продавец назвал как новый товар. Лежат здесь, пока в отчётах не появится '
      +'артикул ВБ или Озона; после этого заводится карточка (add-catalog-cards.cjs / new-codes.cjs oz) '
      +'и код убирается. Проверять при КАЖДОЙ заливке: node scripts/new-codes.cjs check <файлы…>'};
  fs.writeFileSync(path.join(OUT,'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
}

function show(){
  if(!list.length){ console.log('Список новых кодов пуст.'); return; }
  console.log('НОВЫЕ КОДЫ В ОЖИДАНИИ — '+list.length
    +(RD.meta.newCodes&&RD.meta.newCodes.updatedAt? ' (обновлён '+RD.meta.newCodes.updatedAt+')':'')+':');
  list.forEach(it=>{
    const w=where(it.code);
    const st=[];
    if(w.wb) st.push('ВБ '+w.wb.join(','));
    if(w.oz) st.push('Ozon '+w.oz);
    if(it.wbSku && !w.wb) st.push('найден арт. ВБ '+it.wbSku+' — ЗАВОДИТЬ КАРТОЧКУ');
    if(it.ozonSku && !w.oz) st.push('найден SKU Озона '+it.ozonSku+' — ЗАВОДИТЬ КАРТОЧКУ');
    console.log('   '+it.code+'  '+(st.length? st.join(' · ') : 'артикулов пока нет')
      +(it.name? '  — '+String(it.name).slice(0,46) : '')
      +(it.note? '   ['+it.note+']' : '')+'   добавлен '+(it.addedAt||'?'));
  });
  const ready=list.filter(it=>{const w=where(it.code);return (it.wbSku&&!w.wb)||(it.ozonSku&&!w.oz);});
  if(ready.length) console.log('\nГОТОВЫ К ЗАВЕДЕНИЮ: '+ready.map(x=>x.code).join(', '));
  const live=list.filter(it=>{const w=where(it.code);return w.wb||w.oz;});
  if(live.length) console.log('УЖЕ В КАТАЛОГЕ (можно убрать drop): '+live.map(x=>x.code).join(', '));
}

// ── поиск кодов в произвольном отчёте ────────────────────────────────────────
function scanFile(file,codes){
  const hits={};
  const put=(code,key,val)=>{ if(val==null||val==='')return; const h=hits[code]||(hits[code]={}); if(!h[key])h[key]=val; };
  const ext=path.extname(file).toLowerCase();
  let sheets=[];
  if(ext==='.csv'){
    const txt=fs.readFileSync(file,'utf8');
    const sep=(txt.split('\n')[0]||'').split(';').length>1? ';' : ',';
    sheets=[{name:path.basename(file), rows:txt.split(/\r?\n/).map(l=>l.split(sep))}];
  }else{
    if(!XLSX) throw new Error('нет пакета xlsx — поставьте: cd scripts && npm install');
    const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
    sheets=wb.SheetNames.map(n=>({name:n, rows:XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,blankrows:false})}));
  }
  sheets.forEach(sh=>{
    // шапку ищем в первых 15 строках — у отчётов она бывает не первой
    let hi=-1, hdr=null;
    for(let i=0;i<Math.min(15,sh.rows.length);i++){
      const r=(sh.rows[i]||[]).map(x=>String(x==null?'':x));
      if(r.some(x=>/артикул|sku|код/i.test(x))){ hi=i; hdr=r; break; }
    }
    const find=re=>hdr? hdr.findIndex(x=>re.test(x)) : -1;
    const iWb   = find(/артикул\s*wb|артикул\s*вб|код\s*wildberries|артикул\s*wildberries/i);
    const iOz   = find(/^sku$|sku\s*озон|код\s*ozon/i);
    const iName = find(/наименование|название|номенклатура|товар$/i);
    const iCat  = find(/категория|предмет|вид\s*товара/i);
    sh.rows.forEach((r,ri)=>{
      if(!r||ri===hi) return;
      let found=null;
      for(const cell of r){ const t=norm(cell); if(codes.has(t)){ found=t; break; } }
      if(!found) return;
      put(found,'file',path.basename(file));
      put(found,'sheet',sh.name);
      if(iWb>=0)   put(found,'wbSku',norm(r[iWb]));
      if(iOz>=0)   put(found,'ozonSku',norm(r[iOz]));
      if(iName>=0) put(found,'name',String(r[iName]==null?'':r[iName]).trim());
      if(iCat>=0)  put(found,'cat',String(r[iCat]==null?'':r[iCat]).trim());
    });
  });
  return hits;
}

// ── команды ──────────────────────────────────────────────────────────────────
if(cmd==='list'){ show(); process.exit(0); }

if(cmd==='add'){
  const codes=String(argv[1]||'').split(/[,;\s]+/).map(norm).filter(Boolean);
  if(!codes.length){ console.error('usage: node scripts/new-codes.cjs add "519333, 519334" [--note "…"]'); process.exit(1); }
  const note=arg('note')||null;
  let add=0, dup=0;
  codes.forEach(c=>{
    if(list.some(x=>x.code===c)){ dup++; return; }
    list.push({code:c, addedAt:today, note, wbSku:null, ozonSku:null, name:null});
    add++;
  });
  save();
  console.log('Добавлено '+add+(dup? ', уже были: '+dup : ''));
  console.log('');
  show();
  console.log('\nДальше: при следующей заливке — node scripts/new-codes.cjs check <файлы отчётов…>');
  process.exit(0);
}

if(cmd==='drop'){
  const codes=String(argv[1]||'').split(/[,;\s]+/).map(norm).filter(Boolean);
  if(!codes.length){ console.error('usage: node scripts/new-codes.cjs drop "519333"'); process.exit(1); }
  const before=list.length;
  codes.forEach(c=>{ const i=list.findIndex(x=>x.code===c); if(i>=0) list.splice(i,1); else console.log('   '+c+' — не в списке'); });
  save();
  console.log('Убрано '+(before-list.length)+' · осталось '+list.length);
  process.exit(0);
}

if(cmd==='oz'){
  const code=norm(argv[1]), sku=norm(argv[2]);
  if(!code||!sku){ console.error('usage: node scripts/new-codes.cjs oz <код1С> <ozonSku> [--name "…"] [--cat "…"]'); process.exit(1); }
  if(!O.catalog){ console.error('в снимке нет каталога Озона'); process.exit(1); }
  if(ozBy[code]){ console.log('Карточка Озона '+code+' уже есть — ничего не меняю.'); process.exit(0); }
  const it=list.find(x=>x.code===code)||{};
  const wb=(wbBySup[code]||[])[0]||null;
  /* `wbCategory` НУЖНА ДАЖЕ БЕЗ КАРТОЧКИ ВБ. В режиме «Всего» категория берётся как
     `wbCategory || category`, и товар без неё притащил бы на общую вкладку озоновское
     название («Каталка»), которого в списке категорий ВБ нет, — инвариант «чужих категорий
     на Всего ноль» ломается, а фильтр делит выборку. Поэтому при отсутствии связки с ВБ
     категорию ВБ задаём руками через --wbcat. */
  const wbCat=arg('wbcat')||(wb? wb.category : null);
  if(!wbCat) console.log('ВНИМАНИЕ: не задана категория ВБ (--wbcat) и нет карточки ВБ — '
    +'на вкладке «Всего» товар попадёт в чужую категорию. Задайте --wbcat из списка категорий ВБ.');
  const c={sku:code, name:arg('name')||it.name||code, category:arg('cat')||it.cat||'Без категории',
    wbSku:wb? wb.sku : null, wbCategory:wbCat,
    ozStock:0, ozTransit:0, ozonSku:sku};
  O.catalog.push(c);
  if(it.code) it.ozonSku=sku;
  save();
  console.log('Заведена карточка Озона: '+code+' · ozonSku '+sku+' · «'+c.name+'» · '+c.category
    +(wb? ' · связка с ВБ '+wb.sku : ' · связки с ВБ НЕТ (артикула ВБ пока не видно)'));
  console.log('Остаток 0 и «в пути» 0 — подтянутся из ближайшего stocks_report.');
  console.log('Дальше: node scripts/encrypt.cjs <код>');
  process.exit(0);
}

if(cmd==='oz-bulk'){
  /* ПАКЕТНОЕ ЗАВЕДЕНИЕ КАРТОЧЕК ОЗОНА ИЗ ВЫГРУЗКИ СО СВЯЗКОЙ «код 1С → SKU Озона».
     Нужно потому, что каталог Озона собирается ТОЛЬКО из того, что встретилось в заказах
     и в отчёте остатков: товар, заведённый на площадке, но пока не продававшийся и не
     отгруженный, в него не попадает вовсе. Продавец видит его в своём перечне и ждёт,
     что он есть и у нас. Файл — выгрузка XWAY по ВБ («Артикул продавца» + «SKU»). */
  const file=argv[1];
  if(!file){ console.error('usage: node scripts/new-codes.cjs oz-bulk <файл.xlsx> [лист] [--apply]'); process.exit(1); }
  if(!XLSX){ console.error('нет пакета xlsx — cd scripts && npm install'); process.exit(1); }
  if(!O.catalog){ console.error('в снимке нет каталога Озона'); process.exit(1); }
  const apply=argv.includes('--apply');
  const wbk=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
  const sheet=(argv[2]&&!argv[2].startsWith('--'))? argv[2] : wbk.SheetNames[0];
  const rows=XLSX.utils.sheet_to_json(wbk.Sheets[sheet],{header:1,blankrows:false});
  const hdr=(rows[0]||[]).map(x=>String(x==null?'':x));
  const i1c=hdr.findIndex(x=>/артикул\s*продавца|код\s*1с|код\s*поставщика/i.test(x));
  const iSku=hdr.findIndex(x=>/^sku$/i.test(x));
  const iName=hdr.findIndex(x=>/название|наименование/i.test(x));
  if(i1c<0||iSku<0){ console.error('не нашёл колонки «Артикул продавца» и «SKU». Шапка: '+hdr.join(' | ')); process.exit(1); }
  const add=[], skip=[], bad=[];
  rows.slice(1).forEach(r=>{
    const code=norm(r[i1c]), sku=norm(r[iSku]);
    if(!code) return;
    if(!sku||!/^\d{6,}$/.test(sku)){ bad.push(code); return; }
    if(ozBy[code]){ skip.push(code); return; }
    if(add.some(x=>x.code===code)) return;
    const wb=(wbBySup[code]||[])[0]||null;
    add.push({code, sku, name:(iName>=0? String(r[iName]||'').trim() : '')||code,
      wbSku:wb? wb.sku : null, wbCat:wb? wb.category : null});
  });
  console.log('лист «'+sheet+'» · строк '+(rows.length-1));
  console.log('  уже есть в каталоге Озона: '+skip.length);
  if(bad.length) console.log('  без SKU Озона (пропущены): '+bad.length+'  '+bad.slice(0,12).join(', '));
  console.log('\nК ЗАВЕДЕНИЮ НА ОЗОНЕ: '+add.length);
  const noWb=add.filter(x=>!x.wbSku);
  add.forEach(x=>console.log('   1С '+x.code+' · ozonSku '+x.sku+' · '+(x.wbCat||'БЕЗ СВЯЗКИ С ВБ')+' · '+x.name.slice(0,42)));
  if(noWb.length) console.log('\nБЕЗ КАРТОЧКИ ВБ (категория ВБ не определится, на «Всего» уедут в чужую категорию): '
    +noWb.map(x=>x.code).join(', ')+' — их пропускаю, заведите сначала карточку ВБ');
  if(!apply){ console.log('\nСУХОЙ ПРОГОН. Ничего не записано. Повторите с --apply.'); process.exit(0); }
  /* РЯД ЗАКАЗОВ ЗАВОДИМ НУЛЯМИ, А НЕ ОСТАВЛЯЕМ ПУСТЫМ. Правило снимка: ряды `byArt`
     строго одной длины с `dates` (то же, что у ВБ в `bySku`). Карточка без ряда — это
     отсутствующий ключ, и каждый потребитель («Динамика», «Всего», подсорт) должен сам
     догадаться подставить ноль; один забывчивый рендер даёт съехавший график. */
  const OS=(O.orderSeries&&Array.isArray(O.orderSeries.dates))? O.orderSeries : null;
  let n=0, z=0;
  add.forEach(x=>{ if(!x.wbSku) return;
    O.catalog.push({sku:x.code, name:x.name, category:'Без категории',
      wbSku:x.wbSku, wbCategory:x.wbCat, ozStock:0, ozTransit:0, ozonSku:x.sku});
    if(OS && !OS.byArt[x.code]){ OS.byArt[x.code]=new Array(OS.dates.length).fill(0); z++; }
    n++; });
  if(z) console.log('нулевые ряды заказов заведены: '+z+' (длина '+OS.dates.length+', как dates)');
  save();
  console.log('\nЗаведено карточек Озона: '+n+' · в каталоге Озона теперь '+O.catalog.length);
  console.log('Остатки 0 — подтянутся из ближайшего stocks_report. Родные категории Озона'
    +' проставит ozon-category.cjs из отчёта «Аналитика → По товарам».');
  console.log('Дальше: node scripts/encrypt.cjs <код>');
  process.exit(0);
}

if(cmd==='check'){
  const files=argv.slice(1).filter(x=>!x.startsWith('--'));
  if(!files.length){ console.error('usage: node scripts/new-codes.cjs check <файл.xlsx|csv> [ещё…]'); process.exit(1); }
  if(!list.length){ console.log('Список новых кодов пуст — искать нечего.'); process.exit(0); }
  const codes=new Set(list.map(x=>x.code));
  const all={};
  files.forEach(f=>{
    let h; try{ h=scanFile(f,codes); }catch(e){ console.log('  '+path.basename(f)+' — не прочитан: '+e.message); return; }
    Object.entries(h).forEach(([c,v])=>{ const a=all[c]||(all[c]={});
      Object.entries(v).forEach(([k,val])=>{ if(!a[k]||(k==='wbSku'||k==='ozonSku')&&!a[k]) a[k]=val; }); });
  });
  if(!Object.keys(all).length){ console.log('Ни один из '+list.length+' ожидающих кодов в этих файлах не встретился.'); process.exit(0); }
  console.log('НАЙДЕНО В ОТЧЁТАХ:');
  let changed=0;
  Object.entries(all).forEach(([c,v])=>{
    const it=list.find(x=>x.code===c); if(!it) return;
    const upd=[];
    if(v.wbSku && /^\d{6,}$/.test(v.wbSku) && it.wbSku!==v.wbSku){ it.wbSku=v.wbSku; upd.push('арт. ВБ '+v.wbSku); }
    if(v.ozonSku && /^\d{6,}$/.test(v.ozonSku) && it.ozonSku!==v.ozonSku){ it.ozonSku=v.ozonSku; upd.push('SKU Озона '+v.ozonSku); }
    if(v.name && !it.name){ it.name=v.name; }
    if(v.cat && !it.cat){ it.cat=v.cat; }
    if(upd.length) changed++;
    console.log('   '+c+'  '+(upd.length? upd.join(' · ') : 'встретился, но артикула в этом файле нет')
      +'   ['+v.file+' / '+v.sheet+']'+(it.name? '  — '+String(it.name).slice(0,42) : ''));
  });
  if(changed) save();
  console.log('\nОбновлено записей: '+changed);
  const ready=list.filter(it=>{const w=where(it.code);return (it.wbSku&&!w.wb)||(it.ozonSku&&!w.oz);});
  if(ready.length){
    console.log('ГОТОВЫ К ЗАВЕДЕНИЮ — '+ready.map(x=>x.code).join(', '));
    console.log('  с артикулом ВБ → node scripts/add-catalog-cards.cjs <файл.xlsx> --apply');
    console.log('  только Озон    → node scripts/new-codes.cjs oz <код> <ozonSku> --name "…" --cat "…"');
  }
  process.exit(0);
}

console.error('usage: node scripts/new-codes.cjs list | add "коды" [--note …] | check <файлы…> | oz <код> <ozonSku> | drop "коды"');
process.exit(1);
