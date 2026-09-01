// Группы рекламы, которые ВЫВЕДЕНЫ из ассортимента: на вкладке «Реклама» они не считаются.
// Пишет meta.adOutGroups + meta.adOutMembers. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. Продавец решил (01.09.2026): весь товар в группах «Машинки», «Парковки»,
// «Распродажа», «Трансформеры» идёт на вывод — реклама по ним не разбирается, ДРР по ним
// не считается, в рекомендации они не попадают. Держать это в коде нельзя: список живой,
// и сам продавец предупредил — «если дальше в этих группах изменится ассортимент,
// сигнализируй, возможно группы обновятся новым ассортиментом».
//
// ПОЭТОМУ ХРАНИМ ДВЕ ВЕЩИ:
//   · `meta.adOutGroups` — сам список групп;
//   · `meta.adOutMembers` — СЛЕПОК состава каждой группы на момент решения (артикулы ВБ).
// `update-ad-tags.cjs` при каждой заливке сверяет состав со слепком и печатает, что
// появилось нового. Новый артикул в выведенной группе — это, скорее всего, обновление
// ассортимента, и решение «не смотреть» для него уже не действует автоматически.
//
// Использование:
//   node scripts/ad-out-groups.cjs list
//   node scripts/ad-out-groups.cjs set "Машинки" "Парковки" "Распродажа" "Трансформеры"
//   node scripts/ad-out-groups.cjs add "Рули"
//   node scripts/ad-out-groups.cjs drop "Парковки"
//   node scripts/ad-out-groups.cjs resnap        — перезаписать слепок состава (после сверки)
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const cmd=process.argv[2]||'list', args=process.argv.slice(3);

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
RD.meta=RD.meta||{};
const S=v=>(''+(v==null?'':v)).trim();

function membersOf(groups){
  const m={};
  groups.forEach(g=>{ m[g]=(RD.catalog||[]).filter(c=>S(c.adGroup)===g).map(c=>''+c.sku).sort(); });
  return m;
}
function save(){
  fs.writeFileSync(path.join(OUT,'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
}
const cur=RD.meta.adOutGroups||[];

if(cmd==='list'){
  const all={}; (RD.catalog||[]).forEach(c=>{ if(c.adGroup) all[c.adGroup]=(all[c.adGroup]||0)+1; });
  console.log('Группы рекламы (карточек в каталоге):');
  Object.entries(all).sort((a,b)=>b[1]-a[1]).forEach(([g,n])=>
    console.log('   '+String(n).padStart(4)+'  '+g+(cur.includes(g)? '   ← НА ВЫВОД, не считается':'')));
  if(!cur.length) console.log('\nВыведенных групп нет.');
  else { console.log('\nВыведены: '+cur.join(', '));
    const snap=RD.meta.adOutMembers||{};
    console.log('Слепок состава снят: '+(RD.meta.adOutAt||'—'));
    Object.entries(membersOf(cur)).forEach(([g,list])=>{
      const was=new Set(snap[g]||[]);
      const add=list.filter(x=>!was.has(x));
      if(add.length) console.log('   '+g+': НОВЫХ артикулов '+add.length+' — '+add.slice(0,10).join(', ')+(add.length>10?' …':''));
    });
  }
  process.exit(0);
}

let next=cur.slice();
if(cmd==='set') next=args.map(S).filter(Boolean);
else if(cmd==='add') args.map(S).filter(Boolean).forEach(g=>{ if(!next.includes(g)) next.push(g); });
else if(cmd==='drop') next=next.filter(g=>!args.map(S).includes(g));
else if(cmd!=='resnap'){ console.error('команды: list | set <группы…> | add <группа> | drop <группа> | resnap'); process.exit(1); }

const known=new Set((RD.catalog||[]).map(c=>S(c.adGroup)).filter(Boolean));
const unknown=next.filter(g=>!known.has(g));
if(unknown.length){ console.error('Таких групп нет в каталоге: '+unknown.join(', ')
  +'\nЕсть: '+[...known].join(', ')); process.exit(1); }

RD.meta.adOutGroups=next;
RD.meta.adOutMembers=membersOf(next);
RD.meta.adOutAt=new Date().toISOString().slice(0,10);
save();

const cnt=Object.fromEntries(Object.entries(RD.meta.adOutMembers).map(([g,l])=>[g,l.length]));
console.log('Выведены из расчёта рекламы: '+(next.length? next.join(', ') : '(пусто)'));
Object.entries(cnt).forEach(([g,n])=>console.log('   '+String(n).padStart(4)+'  '+g));
console.log('Слепок состава снят на '+RD.meta.adOutAt+' — при следующей заливке склеек сверю и скажу, если появится новый товар.');
console.log('Дальше: node scripts/encrypt.cjs <код>');
