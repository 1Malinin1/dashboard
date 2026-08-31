// Убирает из каталога Озона карточки, которых на площадке НЕТ ВООБЩЕ.
// По умолчанию — сухой прогон (только показывает), запись — с флагом --apply.
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. Каталог Озона собирается по связке «артикул Озона = supplierCode ВБ», поэтому
// в него попадают и товары, которых продавец на Озоне не заводил. Они висят в фильтрах
// и в подсорте как «стартовая партия», хотя везти их некуда.
//
// ЧТО СЧИТАЕТСЯ «НЕТУ». Только полное отсутствие следов — все пять признаков нулевые:
//   остаток на Озоне · заявки/поставки в пути · заказы за всю историю · строки воронки ·
//   числовой SKU Озона (он появляется, только если карточка реально есть).
// Товар, у которого есть SKU Озона или строки воронки, НЕ УДАЛЯЕТСЯ, даже если сейчас
// остаток и продажи нулевые: карточка существует, просто товар кончился. Удалять такие —
// значит потерять историю показов и конверсий.
//
// Использование:
//   node scripts/ozon-prune.cjs            — показать, что будет удалено
//   node scripts/ozon-prune.cjs --apply    — удалить
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const APPLY=process.argv.includes('--apply');

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD, OZ=RD.ozon;
if(!OZ||!OZ.catalog||!OZ.catalog.length){ console.error('в снимке нет каталога Озона'); process.exit(1); }
const S=OZ.orderSeries||{dates:[],byArt:{},money:{}};
const funCnt={}; (OZ.funnel||[]).forEach(r=>{ funCnt[''+r.sku]=(funCnt[''+r.sku]||0)+1; });

const trace=c=>{ const a=(S.byArt&&S.byArt[''+c.sku])||[];
  return { st:c.ozStock||0, tr:c.ozTransit||0, inc:c.ozIncoming||0,
    ord:a.reduce((x,y)=>x+(y||0),0), fun:funCnt[''+c.sku]||0, ozSku:c.ozonSku||null }; };
const empty=c=>{ const t=trace(c); return !t.st && !t.tr && !t.ord && !t.fun && !t.ozSku; };

const dead=OZ.catalog.filter(empty);
const keep=OZ.catalog.filter(c=>!empty(c));
console.log('Каталог Озона: '+OZ.catalog.length+' товаров · без единого следа на площадке: '+dead.length);
if(dead.length){
  console.log('\nБудут убраны (нет остатка, поставок, заказов, воронки и SKU Озона):');
  dead.forEach(c=>console.log('   '+String(c.sku).padEnd(9)+String(c.category||'—').padEnd(18)+(c.name||'').slice(0,44)));
}
// «пусто сейчас, но карточка есть» — их НЕ трогаем, но показываем, чтобы не было сюрприза
const idle=keep.filter(c=>{const t=trace(c); return !t.st && !t.tr && !t.ord;});
if(idle.length){
  console.log('\nОставлены (сейчас пусто, но карточка на Озоне существует — есть SKU и/или воронка): '+idle.length);
  idle.slice(0,10).forEach(c=>{const t=trace(c);
    console.log('   '+String(c.sku).padEnd(9)+'sku '+String(t.ozSku||'—').padEnd(11)+'воронка '+String(t.fun).padStart(3)
      +'  '+(c.name||'').slice(0,40));});
  if(idle.length>10) console.log('   … и ещё '+(idle.length-10));
}
if(!APPLY){ console.log('\nСухой прогон. Чтобы применить: node scripts/ozon-prune.cjs --apply'); process.exit(0); }
if(!dead.length){ console.log('\nУдалять нечего.'); process.exit(0); }

const drop=new Set(dead.map(c=>''+c.sku));
OZ.catalog=keep;
if(S.byArt) Object.keys(S.byArt).forEach(k=>{ if(drop.has(k)) delete S.byArt[k]; });
if(S.money) Object.values(S.money).forEach(m=>Object.keys(m).forEach(k=>{ if(drop.has(k)) delete m[k]; }));
if(OZ.funnel) OZ.funnel=OZ.funnel.filter(r=>!drop.has(''+r.sku));

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('\nУбрано '+dead.length+' карточек · в каталоге Озона осталось '+OZ.catalog.length);
console.log('Дальше: node scripts/encrypt.cjs <код>');
