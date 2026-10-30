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
/* ОБЩИЕ РАСЧЁТЫ calc/*.js (30.10.2026) подключены из index.html как <script src="calc/NAME.js?v=…">. Их тоже
   кеширует Pages, поэтому ?v= = отпечаток содержимого файла: изменился расчёт → меняется index.html → меняется
   build → страница перезагружается мимо кеша и тянет новый calc по новому адресу. */
let src=fs.readFileSync(idx,'utf8');
const src0=src;
src=src.replace(/(<script src="calc\/)([\w.-]+\.js)\?v=[\w]*(")/g,(m,a,f,b)=>{
  const fp=path.join(ROOT,'calc',f);
  if(!fs.existsSync(fp)){ console.error('stamp-build: нет файла calc/'+f+', а index.html его подключает'); process.exit(1); }
  return a+f+'?v='+crypto.createHash('sha1').update(fs.readFileSync(fp)).digest('hex').slice(0,10)+b; });
if(src!==src0){ fs.writeFileSync(idx,src); console.log('calc: версии подключённых файлов обновлены в index.html'); }
const html=fs.readFileSync(idx);
const build=crypto.createHash('sha1').update(html).digest('hex').slice(0,10);
let j={}; try{ j=JSON.parse(fs.readFileSync(vf,'utf8')); }catch(e){}
const was=j.build;
j.build=build; j.stampedAt=new Date().toISOString();
fs.writeFileSync(vf,JSON.stringify(j)+'\n');
console.log('build '+(was?was+' → ':'')+build+(was===build? '  (index.html не менялся)':'  · data-version.json обновлён'));
