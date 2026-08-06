// Проставляет в data-version.json отпечаток index.html (поле build).
// Зачем: GitHub Pages кеширует сам index.html, и после правок кода продавец ещё минут
// десять видит старую страницу. Страница сверяет build из data-version.json (грузится
// без кеша) со своим адресом ?b=… и при расхождении один раз перезагружается по новому
// адресу — это гарантированно свежая загрузка мимо кеша.
//
// ЗАПУСКАТЬ ПЕРЕД КАЖДЫМ КОММИТОМ, КОТОРЫЙ МЕНЯЕТ index.html:
//   node scripts/stamp-build.cjs
'use strict';
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const ROOT=path.join(__dirname,'..');
const idx=path.join(ROOT,'index.html'), vf=path.join(ROOT,'data-version.json');
const html=fs.readFileSync(idx);
const build=crypto.createHash('sha1').update(html).digest('hex').slice(0,10);
let j={}; try{ j=JSON.parse(fs.readFileSync(vf,'utf8')); }catch(e){}
const was=j.build;
j.build=build; j.stampedAt=new Date().toISOString();
fs.writeFileSync(vf,JSON.stringify(j)+'\n');
console.log('build '+(was?was+' → ':'')+build+(was===build? '  (index.html не менялся)':'  · data-version.json обновлён'));
