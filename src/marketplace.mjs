import { fail, integer, text, uuid, now, jsonParse, permit, sha } from './security.mjs';
const q = (db, sql, ...p) => db.prepare(sql).bind(...p);
const guard = db => db.prepare('INSERT INTO write_guards(value) VALUES(changes())');
export const expenseKeys = ['seller_payout','delivery','payment','packaging','gift','tax','marketing','overhead','reserve','other'];
export function economics(revenue, costs) {
  integer(revenue, 0);
  if (!costs || typeof costs !== 'object' || Array.isArray(costs)) fail('COSTS_REQUIRED');
  let total = 0;
  for (const key of expenseKeys) {
    if (costs[key] === null || costs[key] === undefined) fail('COSTS_REQUIRED');
    total += integer(costs[key]);
  }
  const required_net = Math.ceil(revenue / 10), net = revenue - total;
  return {revenue, total_expenses:total, net, required_net, eligible:net>=required_net};
}
function titles(v) {
  if (!v || typeof v !== 'object') fail('INVALID_INPUT');
  return Object.fromEntries(['ru','ka','en'].map(l=>[l,text(v[l],160,true)]));
}
function publicPromotion(p) {
  return {id:p.id,vendor_id:p.vendor_id,product_id:p.product_id,kind:p.kind,titles:jsonParse(p.titles,{}),gift:jsonParse(p.gift,{}),discount_bps:p.discount_bps,base_price:p.base_price,sale_price:p.sale_price,state:p.state,version:p.version};
}
export async function listPromotions(db, vendor, user) {
  if (user) permit(user,vendor,['ADMIN']);
  const rows = (await q(db,`SELECT * FROM promotions WHERE vendor_id=? ${user?'':"AND state='ACTIVE'"} ORDER BY created_at DESC,id`,vendor).all()).results;
  return {promotions:rows.map(p=>({...publicPromotion(p),...(user?.owner?{budget:jsonParse(p.budget)}:{})}))};
}
export async function rankedVendors(db, city) {
  // Stable, real completed-and-paid sales in the last 30 days; no manual boosts.
  return (await q(db,`SELECT v.*,c.currency,c.timezone,
    COALESCE(s.revenue,0) AS sales_revenue,COALESCE(s.orders,0) AS sales_orders
    FROM vendors v JOIN cities c ON c.id=v.city_id LEFT JOIN
    (SELECT vendor_id,SUM(items_total) AS revenue,COUNT(*) AS orders FROM orders
     WHERE status='COMPLETED' AND payment='PAID' AND updated_at>=? GROUP BY vendor_id) s ON s.vendor_id=v.id
    WHERE v.active=1 AND c.active=1 AND v.city_id=?
    ORDER BY sales_revenue DESC,sales_orders DESC,v.id`,new Date(Date.now()-30*86400000).toISOString(),city).all()).results;
}
async function replay(db,b,user) {
  const command=text(b.command,80,true);
  if(!/^[a-zA-Z0-9-]{20,80}$/.test(command)) fail('INVALID_IDEMPOTENCY');
  const fingerprint=await sha(JSON.stringify(b)), prior=await q(db,'SELECT * FROM commands WHERE id=?',command).first();
  if(prior && (prior.actor!==user.id || prior.fingerprint!==fingerprint)) fail('IDEMPOTENCY_CONFLICT',409);
  return {command,fingerprint,prior:prior?jsonParse(prior.result):null};
}
async function commit(db,statements,ctx,user,vendor,event,result) {
  const at=now();
  statements.push(q(db,'INSERT INTO audit(id,at,actor,vendor_id,event,data) VALUES(?,?,?,?,?,?)',uuid(),at,user.id,vendor,event,JSON.stringify(result)),q(db,'INSERT INTO commands(id,actor,fingerprint,result) VALUES(?,?,?,?)',ctx.command,user.id,ctx.fingerprint,JSON.stringify(result)),db.prepare('DELETE FROM write_guards'));
  await db.batch(statements);
  return result;
}
export async function promotionAction(db,b,user) {
  permit(user,b.vendor_id,['ADMIN']);
  const ctx=await replay(db,b,user);
  if(ctx.prior) return ctx.prior;
  if(b.action==='propose') {
    if(!['DISCOUNT','GIFT'].includes(b.kind)) fail('INVALID_INPUT');
    const p=await q(db,'SELECT * FROM products WHERE id=? AND vendor_id=? AND active=1',b.product_id,b.vendor_id).first();
    if(!p) fail('NOT_FOUND',404);
    if(jsonParse(p.options,[]).length) fail('PROMOTION_OPTIONS');
    const discount=b.kind==='DISCOUNT'?integer(b.discount_bps,1,9000):0;
    const sale=p.price-Math.floor(p.price*discount/10000);
    if(sale<=0) fail('INVALID_NUMBER');
    const id=uuid();
    const gift=b.kind==='GIFT'?titles(b.gift):{};
    return commit(db,[q(db,'INSERT INTO promotions(id,vendor_id,product_id,kind,titles,gift,discount_bps,base_price,sale_price,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,b.vendor_id,p.id,b.kind,JSON.stringify(titles(b.titles)),JSON.stringify(gift),discount,p.price,sale,user.id,now())],ctx,user,b.vendor_id,'PROMOTION_PROPOSED',{id,state:'PROPOSED'});
  }
  const promo=await q(db,'SELECT * FROM promotions WHERE id=? AND vendor_id=?',b.id,b.vendor_id).first();
  if(!promo) fail('NOT_FOUND',404);
  if(promo.version!==integer(b.version)) fail('CONFLICT',409);
  const p=await q(db,'SELECT * FROM products WHERE id=? AND vendor_id=?',promo.product_id,b.vendor_id).first();
  if(b.action==='publish') {
    if(!user.owner) fail('FORBIDDEN',403);
    if(promo.state!=='PROPOSED'||p.price!==promo.base_price||!p.active) fail('CONFLICT',409);
    if(b.costs_confirmed!==true) fail('COSTS_REQUIRED');
    const budget=economics(promo.sale_price,b.expenses);
    if(!budget.eligible) fail('MARGIN_BELOW_MINIMUM',409);
    // Explicit per-unit worst-case expense ceilings; never label this forecast as actual profit.
    const statements=[q(db,"UPDATE promotions SET state='ACTIVE',budget=?,approved_by=?,version=version+1 WHERE id=? AND state='PROPOSED' AND version=?",JSON.stringify({expenses:b.expenses,...budget,evidence:text(b.evidence,1000,true)}),user.id,promo.id,promo.version),guard(db),q(db,'UPDATE products SET price=?,version=version+1 WHERE id=? AND version=? AND price=?',promo.sale_price,p.id,p.version,promo.base_price),guard(db)];
    return commit(db,statements,ctx,user,b.vendor_id,'PROMOTION_PUBLISHED',{id:promo.id,state:'ACTIVE',forecast:budget});
  }
  if(b.action==='stop') {
    if(promo.state==='STOPPED') fail('CONFLICT',409);
    const statements=[];
    if(promo.state==='ACTIVE') {
      if(p.price!==promo.sale_price) fail('CONFLICT',409);
      statements.push(q(db,'UPDATE products SET price=?,version=version+1 WHERE id=? AND version=? AND price=?',promo.base_price,p.id,p.version,promo.sale_price),guard(db));
    }
    statements.push(q(db,"UPDATE promotions SET state='STOPPED',version=version+1 WHERE id=? AND version=?",promo.id,promo.version),guard(db));
    return commit(db,statements,ctx,user,b.vendor_id,'PROMOTION_STOPPED',{id:promo.id,state:'STOPPED'});
  }
  fail('INVALID_INPUT');
}
export async function settlementAction(db,b,user) {
  if(!user?.owner) fail('FORBIDDEN',403);
  const ctx=await replay(db,b,user);
  if(ctx.prior) return ctx.prior;
  const o=await q(db,'SELECT * FROM orders WHERE id=? AND vendor_id=?',b.order_id,b.vendor_id).first();
  if(!o) fail('NOT_FOUND',404);
  if(o.status!=='COMPLETED'||o.payment!=='PAID'||o.paid!==o.total) fail('SETTLEMENT_NOT_READY',409);
  if(b.costs_confirmed!==true) fail('COSTS_REQUIRED');
  const prior=await q(db,'SELECT * FROM settlements WHERE order_id=?',o.id).first();
  if(prior?.state==='CLOSED') fail('SETTLEMENT_CLOSED',409);
  if((prior?.version??0)!==integer(b.version)) fail('CONFLICT',409);
  const calculation=economics(o.total,b.expenses),state=calculation.eligible?'CLOSED':'SHORTFALL';
  const evidence=text(b.evidence,1000,true),version=(prior?.version??0)+1;
  const statements=[q(db,'UPDATE orders SET version=version+1 WHERE id=? AND version=? AND status=\'COMPLETED\' AND paid=total',o.id,o.version),guard(db)];
  if(prior) statements.push(q(db,'UPDATE settlements SET expenses=?,total_expenses=?,net=?,required_net=?,state=?,evidence=?,actor=?,at=?,version=? WHERE order_id=? AND version=?',JSON.stringify(b.expenses),calculation.total_expenses,calculation.net,calculation.required_net,state,evidence,user.id,now(),version,o.id,prior.version),guard(db));
  else statements.push(q(db,'INSERT INTO settlements(order_id,vendor_id,revenue,expenses,total_expenses,net,required_net,state,evidence,actor,at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',o.id,o.vendor_id,o.total,JSON.stringify(b.expenses),calculation.total_expenses,calculation.net,calculation.required_net,state,evidence,user.id,now(),version));
  return commit(db,statements,ctx,user,o.vendor_id,'SETTLEMENT_RECORDED',{order_id:o.id,...calculation,state,version});
}
export async function termsAction(db,b,user) {
 if(!user?.owner) fail('FORBIDDEN',403);
 const ctx=await replay(db,b,user);if(ctx.prior)return ctx.prior;
 const vendor=await q(db,'SELECT id FROM vendors WHERE id=?',b.vendor_id).first();if(!vendor)fail('NOT_FOUND',404);
 if(b.costs_confirmed!==true)fail('COSTS_REQUIRED');
 const rate=integer(b.seller_payout_bps,0,10000),expenses={...b.expenses,seller_payout:0};
 economics(1,expenses); // validate every ceiling; zero seller payout is replaced by the contractual rate per order.
 const evidence=text(b.evidence,1000,true),prior=await q(db,'SELECT * FROM vendor_terms WHERE vendor_id=?',vendor.id).first();
 if((prior?.version??0)!==integer(b.version))fail('CONFLICT',409);
 const version=(prior?.version??0)+1,statements=[];
 if(prior)statements.push(q(db,'UPDATE vendor_terms SET seller_payout_bps=?,expenses=?,evidence=?,actor=?,at=?,version=? WHERE vendor_id=? AND version=?',rate,JSON.stringify(expenses),evidence,user.id,now(),version,vendor.id,prior.version),guard(db));
 else statements.push(q(db,'INSERT INTO vendor_terms(vendor_id,seller_payout_bps,expenses,evidence,actor,at,version) VALUES(?,?,?,?,?,?,?)',vendor.id,rate,JSON.stringify(expenses),evidence,user.id,now(),version));
 return commit(db,statements,ctx,user,vendor.id,'VENDOR_TERMS_UPDATED',{vendor_id:vendor.id,version});
}
export async function orderEconomics(db,vendor,itemsTotal,deliveryFee,lines) {
 const terms=await q(db,'SELECT * FROM vendor_terms WHERE vendor_id=?',vendor.id).first();
 if(!terms){if(vendor.demo)return null;fail('COSTS_REQUIRED',409);}
 const expenses=jsonParse(terms.expenses,{});
 expenses.seller_payout=Math.ceil(itemsTotal*terms.seller_payout_bps/10000);
 // Include each unit's approved gift budget in addition to the order ceiling.
 for(const line of lines){
   const promo=await q(db,"SELECT budget FROM promotions WHERE product_id=? AND state='ACTIVE' AND kind='GIFT'",line.product_id).first();
   if(promo)expenses.gift+=integer(jsonParse(promo.budget,{}).expenses?.gift)*line.qty;
 }
 const check=economics(itemsTotal+deliveryFee,expenses);
 if(!check.eligible)fail('MARGIN_BELOW_MINIMUM',409);
 return {terms_version:terms.version,expenses,...check};
}
