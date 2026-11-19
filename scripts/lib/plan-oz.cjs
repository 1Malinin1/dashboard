// ПЛАН ЗАКАЗОВ OZON ДЛЯ РЕПРАЙСЕРА (ЗАП-24, 18.11.2026) — одна формула для repricer-plan.cjs и plan-review.cjs.
// r — строка «Запаса и темпа» сайта (srExtend): stockOz, stockWb, wbShip|wbTr, whQty, spdWb, spdOz, ordOz, supplies [{t,q}].
// o: {share (доля партии для МП, PROD_MP_SHARE), H (PLAN_HZ), bo (% выкупа Ozon по товару), nodata (10)}.
// Товар Ozon = остаток Ozon (+ в пути) + свои склады (+ партии × share). С 19.11.2026 (ЗАП-26) ВБ НЕ вычитаем: общий запас до партии —
// в приоритете Ozon (там лучше маржа), ВБ получает остаток (это и считает план ВБ на сайте). До 19.11 вычиталась недостача ВБ.
// Цель — самое жёсткое из «не кончиться до прихода каждой партии» и «дожить до H дней со всеми партиями»; план = цель ÷ выкуп,
// целое ≥ 1. Нет товара вовсе — o.nodata (10). По марже план НЕ подменяем (ЗАП-24).
'use strict';
function planOz(r, o){
  const H=o.H||180, share=o.share==null? 0.65 : o.share, wbOwn=(r.stockWb||0)+(r.wbShip!=null? r.wbShip : (r.wbTr||0));
  const sup=(r.supplies||[]).filter(x=>x.t>0&&x.t<=H).sort((a,b)=>a.t-b.t);
  const all=(r.stockOz||0)+(r.whQty||0)+(r.supplies||[]).reduce((a,x)=>a+(x.q||0),0);
  if(all<=0) return {J:o.nodata||10, raw:null, base:0, take:0, bind:null, hz:H, noGoods:true};
  const baseAt=(t,inc)=>{ const wh=(r.whQty||0)+inc*share, take=0;   // ЗАП-26: приоритет Ozon — ВБ со своих складов для плана Ozon не забирает
    return {base:(r.stockOz||0)+Math.max(0,wh-take), take}; };
  let cum=0, best=Infinity, bind=null, bb=null;
  sup.forEach(x=>{ const v=baseAt(x.t,cum); if(v.base/x.t<best){ best=v.base/x.t; bind=x; bb=v; } cum+=x.q; });
  const vEnd=baseAt(H,cum); if(vEnd.base/H<=best){ best=vEnd.base/H; bind=null; bb=vEnd; }
  const raw=best/(o.bo||0.8);
  return {J:Math.max(1,Math.round(raw)), raw, base:bb.base, take:bb.take, bind, hz:bind? bind.t : H, noGoods:false,
    src: bind? 'не кончиться до партии через '+bind.t+' дн' : (sup.length? 'товар и партии — на '+H+' дн' : 'товар на '+H+' дн: партий нет')};
}
module.exports={planOz};
