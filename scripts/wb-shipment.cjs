// Журнал отгрузок НА WILDBERRIES. Зачем: у Озона поставка видна официально (заявка → в пути →
// остаток), а ВБ путь от отправки до приёмки не показывает. Поэтому продавец сообщает об отгрузке
// сам, мы записываем её сюда, и она считается «в пути на ВБ» до тех пор, пока не приедет.
// Приход закрывается АВТОМАТИЧЕСКИ в update-wb-stock.cjs: если остаток товара вырос — значит
// поставка (или её часть) принята.
//
// Хранится в REAL_DATA.shipments = [{id, mp:'wb', sup, sku, qty, left, date, arrived:[{date,qty}]}]
//   sup   — арт. поставщика (код 1С), общий ключ ВБ/Озона
//   qty   — сколько отгружено, left — сколько ещё не доехало
//
// Использование:
//   node scripts/wb-shipment.cjs add "512190=300, 487175=1200" [дата]   — записать отгрузку
//   node scripts/wb-shipment.cjs list                                    — показать открытые
//   node scripts/wb-shipment.cjs close <id> [кол-во]                     — закрыть вручную
//   node scripts/wb-shipment.cjs drop <id>                               — удалить запись (ошибка ввода)
// Дальше: node scripts/encrypt.cjs <код>
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const cmd=(process.argv[2]||'').toLowerCase();
const DATA=path.join(OUT,'wb-data.js');

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(DATA,'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
RD.shipments=RD.shipments||[];
const bySup={}; RD.catalog.forEach(c=>{ const s=(''+(c.supplierCode||'')).trim(); if(s)(bySup[s]||(bySup[s]=[])).push(c); });
const save=()=>fs.writeFileSync(DATA,'// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
const fmtRow=s=>'  '+s.id+' · '+s.date+' · 1С '+s.sup+' · отгружено '+s.qty+' · не доехало '+s.left
  +'  · '+((bySup[s.sup]&&bySup[s.sup][0]&&bySup[s.sup][0].name)||'').slice(0,40);

if(cmd==='list'){
  const open=RD.shipments.filter(s=>s.left>0), done=RD.shipments.filter(s=>s.left<=0);
  console.log('Открытые отгрузки на ВБ ('+open.length+'), всего в пути '+open.reduce((a,s)=>a+s.left,0)+' шт:');
  open.sort((a,b)=>a.date<b.date?-1:1).forEach(s=>console.log(fmtRow(s)));
  console.log('\nЗакрытые: '+done.length);
  done.slice(-10).forEach(s=>console.log(fmtRow(s)+'  · принято: '+(s.arrived||[]).map(a=>a.date+' '+a.qty).join(', ')));
  process.exit(0);
}
if(cmd==='close'||cmd==='drop'){
  const id=process.argv[3]; const s=RD.shipments.find(x=>x.id===id);
  if(!s){console.error('нет отгрузки с id '+id);process.exit(1);}
  if(cmd==='drop'){ RD.shipments=RD.shipments.filter(x=>x.id!==id); save(); console.log('удалено: '+id); process.exit(0); }
  const q=process.argv[4]? Math.min(s.left,parseInt(process.argv[4],10)) : s.left;
  s.left-=q; (s.arrived||(s.arrived=[])).push({date:new Date().toISOString().slice(0,10),qty:q,manual:true});
  save(); console.log('закрыто '+q+' шт по '+id+' · осталось в пути '+s.left);
  process.exit(0);
}
if(cmd!=='add'){ console.error('usage: add "код=кол-во, код=кол-во" [дата] | list | close <id> [кол-во] | drop <id>'); process.exit(1); }

const spec=process.argv[3]||'';
const date=process.argv[4]||new Date().toISOString().slice(0,10);
if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){console.error('дата должна быть в формате ГГГГ-ММ-ДД');process.exit(1);}
const items=spec.split(/[,;\n]+/).map(x=>x.trim()).filter(Boolean).map(x=>{
  const m=x.split(/[=:\s]+/); return {sup:(m[0]||'').trim(), qty:parseInt((m[1]||'').replace(/\s/g,''),10)}; });
if(!items.length||items.some(x=>!x.sup||!(x.qty>0))){console.error('формат: "512190=300, 487175=1200"');process.exit(1);}

let added=0, unknown=[];
items.forEach(it=>{
  const cat=bySup[it.sup];
  if(!cat){ unknown.push(it.sup); return; }
  const id='wb-'+date.replace(/-/g,'')+'-'+it.sup;
  const ex=RD.shipments.find(s=>s.id===id);
  if(ex){ ex.qty+=it.qty; ex.left+=it.qty; }         // повторная запись за тот же день — суммируем
  else RD.shipments.push({id,mp:'wb',sup:it.sup,sku:cat[0].sku,qty:it.qty,left:it.qty,date,arrived:[]});
  added++;
  console.log('  1С '+it.sup+' · '+it.qty+' шт · '+(cat[0].name||'').slice(0,44)+(cat.length>1? '  (кодом 1С помечено '+cat.length+' артикулов ВБ)':''));
});
if(unknown.length) console.log('\nНЕ найдены в каталоге (пропущены): '+unknown.join(', '));
save();
const open=RD.shipments.filter(s=>s.left>0);
console.log('\nЗаписано отгрузок: '+added+' на дату '+date);
console.log('Всего в пути на ВБ: '+open.reduce((a,s)=>a+s.left,0)+' шт по '+open.length+' позициям');
console.log('Приход закроется сам при следующей заливке остатков ВБ (update-wb-stock.cjs).');
console.log('Дальше: node scripts/encrypt.cjs <код>');
