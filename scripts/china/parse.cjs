// КИТАЙ: разбор двух отчётов 1С в рабочую папку (18.11.2026, ЗАП-21). Дальше — build.cjs, prod-plan.cjs, post.cjs, report.cjs
// (порядок и смысл — справочник/склад-и-подсорт.md, «ЗАКАЗЫ НА ПРОИЗВОДСТВО»).
//   node scripts/china/parse.cjs <«Заказы поставщику».xls> <ведомость «4 пер.».xls> <рабочая папка>
// Пишет <папка>/in-prod/rows.json (строки открытых заказов) и <папка>/in-ved/items.json (товары ведомости с колонкой H).
'use strict';
const fs=require('fs'),path=require('path');const X=require(path.join(__dirname,'..','node_modules','xlsx'));
const [fOrd,fVed,B]=process.argv.slice(2); if(!fOrd||!fVed||!B){ console.error('usage: node scripts/china/parse.cjs <заказы поставщику.xls> <4 пер.xls> <папка>'); process.exit(1); }
const n=v=>typeof v==='number'?v:(+String(v).replace(/\s/g,'').replace(/,/g,'')||0);
const nd=v=>typeof v==='number'?v:(+String(v).replace(/\s/g,'').replace(',','.')||0);
// «Заказы поставщику»: Контрагент → «Заказ поставщику РЧФ… от дд.мм.гггг» → строки «код · · номенклатура · цена · · в дозе · в коробке · всего · объём · сумма · срок изготовления»
const r=X.utils.sheet_to_json(X.readFile(fOrd).Sheets[X.readFile(fOrd,{bookSheets:true}).SheetNames[0]],{header:1,defval:'',raw:true});
let sup='',ord='',ordDate='';const rows=[];
r.forEach((x,i)=>{ if(i<5) return; const a=String(x[0]).trim();
  if(/^Заказ поставщику\s+\S+/.test(a)){ const m=a.match(/Заказ поставщику\s+(\S+)\s+от\s+(\d\d)\.(\d\d)\.(\d{4})/); ord=m?m[1]:a; ordDate=m?m[4]+'-'+m[3]+'-'+m[2]:''; return; }
  if(a==='Заказ поставщику'||/^Итого/.test(a)||!a||a==='Код') return;
  const c=typeof x[0]==='number'? String(x[0]) : a.replace(/[\s,]/g,'');
  if(/^\d{5,7}$/.test(c)) rows.push({row:i+1,sup,ord,ordDate,code:c,name:String(x[2]).trim(),price:n(x[4]),dose:n(x[6]),box:n(x[7]),qty:n(x[8]),vol:n(x[9]),sum:n(x[10]),srok:x[11]});
  else sup=a; });
// «4 пер.»: Код · Номенклатура · В коробке · · Статус · Фото · Акция · Артикул для ВБ (H) · Оптовая · Остатки · Склад в пути Китай · В пути (до таможни) · Склад поставщика Китай · Итого на дату …
const v=X.utils.sheet_to_json(X.readFile(fVed).Sheets[X.readFile(fVed,{bookSheets:true}).SheetNames[0]],{header:1,defval:'',raw:true});
const H=v[0].map(s=>String(s).trim()); const col=re=>H.findIndex(h=>re.test(h));
const I={h:col(/артикул\s+для\s+(вб|wb)/i), ost:col(/^остатки$/i), putK:col(/склад\s+в\s+пути\s+китай/i), putT:col(/в\s+пути.*таможн/i), sklK:col(/склад\s+поставщика/i), opt:col(/оптовая/i), st:col(/статус\s+позиции/i)};
const miss=Object.entries(I).filter(([,i])=>i<0).map(([k])=>k); if(miss.length){ console.error('в «4 пер.» не нашёл колонки: '+miss.join(', ')); process.exit(1); }
let cat='';const items=[];
v.forEach((x,i)=>{ if(i<2) return; const c=String(x[0]).replace(/\s/g,''); if(!c){ if(x[1]) cat=String(x[1]).trim(); return; }
  if(!/^\d{5,7}$/.test(c)) return;
  items.push({row:i+1,code:c,name:String(x[1]).trim(),cat,st:String(x[I.st]).trim(),h:String(x[I.h]).trim().toUpperCase().replace(/\s+/g,''),opt:nd(x[I.opt]),ost:nd(x[I.ost]),putK:nd(x[I.putK]),putT:nd(x[I.putT]),sklK:nd(x[I.sklK])}); });
items.forEach(x=>{ if(x.h==='RF') x.h=''; });   // «RF» — розница, как пусто
fs.mkdirSync(path.join(B,'in-prod'),{recursive:true}); fs.mkdirSync(path.join(B,'in-ved'),{recursive:true});
fs.writeFileSync(path.join(B,'in-prod','rows.json'),JSON.stringify(rows)); fs.writeFileSync(path.join(B,'in-ved','items.json'),JSON.stringify(items));
const mp=items.filter(x=>x.h), S=(a,f)=>a.reduce((s,x)=>s+f(x),0);
console.log('Заказы поставщику: строк '+rows.length+' · кодов '+new Set(rows.map(x=>x.code)).size+' · '+S(rows,x=>x.qty)+' шт');
console.log('«4 пер.»: товаров '+items.length+' · для МП (H = WB / RF/WB) '+mp.length+' · в пути Китай '+S(mp,x=>x.putK)+' · до таможни '+S(mp,x=>x.putT)+' · у поставщика '+S(mp,x=>x.sklK)+' шт');
