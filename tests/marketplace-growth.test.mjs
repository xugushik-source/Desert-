import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1} from '../tools/sqlite.mjs';
import {migrateLocal} from '../tools/migrate-local.mjs';
import {seed,createUser} from '../tools/seed.mjs';
import {handle} from '../src/worker.mjs';
import {economics,expenseKeys,rankedVendors} from '../src/marketplace.mjs';
import {extraWords,eventCart} from '../public/marketplace.js';
const costs=(seller=600)=>Object.fromEntries(expenseKeys.map(k=>[k,k==='seller_payout'?seller:0]));
async function fixture(){
 const db=new LocalD1();migrateLocal(db);await seed(db);
 const password='demonstration-only-password-123';
 for(const [name,owner,vendor] of [['owner',true,null],['seller',false,'sweet-house'],['other',false,'cacao-atelier']]) await createUser(db,{email:name+'@test.invalid',name,password,owner,...(vendor?{vendor_id:vendor,role:'ADMIN'}:{})});
 const env={DB:db,RECOVERY_SECRET:'demonstration-recovery-over-32-characters'};
 async function req(path,body,cookie){const response=await handle(new Request('https://deserto.invalid/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Deserto-CSRF':'1',...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 const cookies={};for(const name of ['owner','seller','other'])cookies[name]=(await req('login',{email:name+'@test.invalid',password})).cookie;
 const propose=(kind='DISCOUNT',product='sweet-house--medovik-slice')=>({command:crypto.randomUUID(),action:'propose',vendor_id:'sweet-house',product_id:product,kind,titles:{ru:'Тестовая акция',ka:'ტესტი',en:'Test offer'},discount_bps:1000,gift:{ru:'Свеча',ka:'სანთელი',en:'Candle'}});
 return {db,req,cookies,propose};
}
test('net income floor rounds up, requires every expense, and never trusts posted profit',()=>{
 assert.equal(economics(1001,costs(900)).eligible,true);
 assert.equal(economics(1001,costs(901)).eligible,false);
 assert.equal(economics(1001,costs(901)).required_net,101);
 const incomplete=costs();delete incomplete.tax;
 assert.throws(()=>economics(1000,incomplete),{code:'COSTS_REQUIRED'});
 assert.throws(()=>economics(1000,{...costs(),tax:null}),{code:'COSTS_REQUIRED'});
 assert.throws(()=>economics(1000,{...costs(),tax:-1}),{code:'INVALID_NUMBER'});
 assert.equal(economics(1000,{...costs(950),profit:10000,eligible:true}).eligible,false);
});
test('seller proposes own promotion; only owner publishes after margin check, actual prices and replay remain correct',async()=>{
 const f=await fixture();try{
 assert.equal((await f.req('manage/promotion',f.propose(),f.cookies.other)).status,403);
 const proposed=await f.req('manage/promotion',f.propose(),f.cookies.seller);assert.equal(proposed.status,200);
 const id=proposed.data.id;
 const publish={command:crypto.randomUUID(),action:'publish',vendor_id:'sweet-house',id,version:0,costs_confirmed:true,evidence:'DEMO expense ceilings',expenses:costs(810)};
 assert.equal((await f.req('manage/promotion',publish,f.cookies.seller)).status,403);
 assert.equal((await f.req('manage/promotion',{...publish,expenses:costs(811)},f.cookies.owner)).data.error,'MARGIN_BELOW_MINIMUM');
 assert.equal((await f.req('catalog?vendor=sweet-house')).data.products.find(p=>p.id==='sweet-house--medovik-slice').price,1000);
 assert.equal((await f.req('manage/promotion',{...publish,expenses:{seller_payout:0}},f.cookies.owner)).data.error,'COSTS_REQUIRED');
 const active=await f.req('manage/promotion',publish,f.cookies.owner);assert.equal(active.data.state,'ACTIVE');
 assert.deepEqual((await f.req('manage/promotion',publish,f.cookies.owner)).data,active.data);
 const p=(await f.req('catalog?vendor=sweet-house')).data.products.find(p=>p.id==='sweet-house--medovik-slice');assert.equal(p.price,900);assert.equal(p.promotion.kind,'DISCOUNT');assert.equal(p.promotion.budget,undefined);
 const draft={idem:crypto.randomUUID(),city_id:'akhalkalaki',vendor_id:'sweet-house',items:[{product_id:p.id,qty:1}],method:'cash',fulfillment:'pickup',day:new Date(Date.now()+2*86400000).toISOString().slice(0,10),minute:720,expected_total:900,customer:{name:'DEMO',phone:'+99500000000'}};
 assert.equal((await f.req('orders',{...draft,expected_total:1000})).data.error,'PRICE_CHANGED');
 assert.equal((await f.req('orders',draft)).data.total,900);
 const stop=await f.req('manage/promotion',{command:crypto.randomUUID(),action:'stop',vendor_id:'sweet-house',id,version:1},f.cookies.seller);assert.equal(stop.data.state,'STOPPED');
 assert.equal((await f.req('catalog?vendor=sweet-house')).data.products.find(p=>p.id===draft.items[0].product_id).price,1000);
 assert.equal((await f.req('orders',draft)).data.total,900); // existing order unchanged
 }finally{f.db.close()}
});
test('gift is a real published fulfilment promise retained on the order, not a decorative badge',async()=>{
 const f=await fixture();try{
 const id=(await f.req('manage/promotion',f.propose('GIFT'),f.cookies.seller)).data.id;
 await f.req('manage/promotion',{command:crypto.randomUUID(),action:'publish',vendor_id:'sweet-house',id,version:0,costs_confirmed:true,evidence:'DEMO candle and all expenses included',expenses:{...costs(700),gift:100}},f.cookies.owner);
 const r=await f.req('orders',{idem:crypto.randomUUID(),city_id:'akhalkalaki',vendor_id:'sweet-house',items:[{product_id:'sweet-house--medovik-slice',qty:1}],method:'cash',fulfillment:'pickup',day:new Date(Date.now()+2*86400000).toISOString().slice(0,10),minute:720,expected_total:1000,customer:{name:'DEMO',phone:'+99500000000'}});
 assert.equal(r.status,201);assert.match(r.data.items[0].note,/Подарок: Свеча/);
 }finally{f.db.close()}
});
test('ranking uses completed paid sales; cancellations, unpaid and foreign-city sales do not lead',async()=>{
 const f=await fixture();try{
 const day=new Date(Date.now()+86400000).toISOString().slice(0,10);
 async function order(vendor,city,price){return (await f.req('orders',{idem:crypto.randomUUID(),city_id:city,vendor_id:vendor,items:[{product_id:vendor+'--eclair',qty:1}],method:'cash',fulfillment:'pickup',day,minute:720,expected_total:price,customer:{name:'DEMO',phone:'+99500000000'}})).data.id;}
 const a=await order('cacao-atelier','tbilisi',550),b=await order('sweet-house-tbilisi','tbilisi',600);
 f.db.prepare("UPDATE orders SET status='COMPLETED',payment='PAID',paid=total WHERE id=?").bind(b)._execute();
 assert.equal((await rankedVendors(f.db,'tbilisi'))[0].id,'sweet-house-tbilisi');
 f.db.prepare("UPDATE orders SET status='COMPLETED',total=20000,items_total=20000 WHERE id=?").bind(a)._execute();
 assert.equal((await rankedVendors(f.db,'tbilisi'))[0].id,'sweet-house-tbilisi');
 f.db.prepare("UPDATE orders SET payment='PAID',paid=total WHERE id=?").bind(a)._execute();
 assert.equal((await rankedVendors(f.db,'tbilisi'))[0].id,'cacao-atelier');
 f.db.prepare("UPDATE orders SET status='CANCELLED' WHERE id=?").bind(a)._execute();
 assert.equal((await rankedVendors(f.db,'tbilisi'))[0].id,'sweet-house-tbilisi');
 assert.equal((await rankedVendors(f.db,'akhalkalaki')).length,1);
 }finally{f.db.close()}
});
test('settlement cannot close below net 10%, missing costs or unpaid delivery; duplicate commands do not duplicate records',async()=>{
 const f=await fixture();try{
 const created=await f.req('orders',{idem:crypto.randomUUID(),city_id:'akhalkalaki',vendor_id:'sweet-house',items:[{product_id:'sweet-house--eclair',qty:2}],method:'cash',fulfillment:'pickup',day:new Date(Date.now()+2*86400000).toISOString().slice(0,10),minute:720,expected_total:1000,customer:{name:'DEMO',phone:'+99500000000'}});
 const id=created.data.id;
 const body={command:crypto.randomUUID(),vendor_id:'sweet-house',order_id:id,version:0,costs_confirmed:true,evidence:'DEMO actual costs, receipts verified',expenses:costs(950)};
 assert.equal((await f.req('manage/settlement',body,f.cookies.seller)).status,403);
 assert.equal((await f.req('manage/settlement',body,f.cookies.owner)).data.error,'SETTLEMENT_NOT_READY');
 for(const action of ['confirm','prepare','ready','handover','payment']) {
   const o=(await f.req('order/view',{id,key:created.data.key})).data;
   const r=await f.req('manage/action',{id,vendor_id:'sweet-house',version:o.version,action,command_id:crypto.randomUUID(),reason:'DEMO',...(action==='payment'?{amount:1000}:{})},f.cookies.owner);
   assert.equal(r.status,200,JSON.stringify(r));
 }
 const result=await f.req('manage/settlement',body,f.cookies.owner);assert.equal(result.data.state,'SHORTFALL');assert.equal(result.data.net,50);
 assert.deepEqual((await f.req('manage/settlement',body,f.cookies.owner)).data,result.data);
 const unknown=await f.req('manage/settlement',{...body,command:crypto.randomUUID(),version:1,expenses:{seller_payout:900}},f.cookies.owner);assert.equal(unknown.data.error,'COSTS_REQUIRED');
 const close={...body,command:crypto.randomUUID(),version:1,expenses:costs(900)};
 assert.equal((await f.req('manage/settlement',close,f.cookies.owner)).data.state,'CLOSED');
 assert.equal((await f.req('manage/settlement',{...close,command:crypto.randomUUID(),version:2},f.cookies.owner)).data.error,'SETTLEMENT_CLOSED');
 assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM settlements').get().n,1);
 assert.equal((await f.req('manage/settlements?vendor=sweet-house',undefined,f.cookies.seller)).status,403);
 migrateLocal(f.db);assert.equal(f.db.sqlite.prepare('SELECT total FROM orders WHERE id=?').get(id).total,1000);
 }finally{f.db.close()}
});
test('event cake selection is idempotent, keeps existing basket items and all new labels have three languages',()=>{
 const p={id:'cake'};const original=[{product_id:'coffee',qty:2,options:[],note:''}];
 const a=eventCart(original,p,'Birthday · 2026-10-20');
 assert.deepEqual(eventCart(a,p,'Birthday · 2026-10-20'),a);assert.equal(a.length,2);assert.equal(original.length,1);
 assert.deepEqual(Object.keys(extraWords.ru).sort(),Object.keys(extraWords.ka).sort());assert.deepEqual(Object.keys(extraWords.ru).sort(),Object.keys(extraWords.en).sort());
});
test('non-demo checkout requires known expense ceilings and rejects margin below 10% before reserving stock',async()=>{
 const f=await fixture();try{
 f.db.exec("UPDATE vendors SET demo=0 WHERE id='sweet-house'");
 const payload={idem:crypto.randomUUID(),city_id:'akhalkalaki',vendor_id:'sweet-house',items:[{product_id:'sweet-house--medovik-slice',qty:1}],method:'cash',fulfillment:'pickup',day:new Date(Date.now()+2*86400000).toISOString().slice(0,10),minute:720,expected_total:1000,customer:{name:'DEMO',phone:'+99500000000'}};
 assert.equal((await f.req('orders',payload)).data.error,'COSTS_REQUIRED');
 const terms={command:crypto.randomUUID(),vendor_id:'sweet-house',version:0,seller_payout_bps:9000,expenses:{...costs(0),packaging:1},costs_confirmed:true,evidence:'DEMO contract and worst-case expense ceilings'};
 assert.equal((await f.req('manage/terms',terms,f.cookies.seller)).status,403);
 assert.equal((await f.req('manage/terms',terms,f.cookies.owner)).status,200);
 assert.equal((await f.req('orders',payload)).data.error,'MARGIN_BELOW_MINIMUM');
 assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM orders').get().n,0);
 assert.equal((await f.req('manage/terms',{...terms,command:crypto.randomUUID(),version:1,seller_payout_bps:8000},f.cookies.owner)).status,200);
 const created=await f.req('orders',{...payload,profit:1000000});assert.equal(created.status,201);
 const check=f.db.sqlite.prepare('SELECT * FROM order_pricing_checks WHERE order_id=?').get(created.data.id);assert.equal(check.net,199);assert.equal(check.required_net,100);
 assert.equal((await f.req('manage/terms?vendor=sweet-house',undefined,f.cookies.seller)).status,403);
 const proposal=await f.req('manage/action',{id:created.data.id,version:created.data.version,command_id:crypto.randomUUID(),action:'propose',reason:'DEMO changed quantity',items:[{product_id:'sweet-house--medovik-slice',qty:2}]},f.cookies.owner);
 assert.equal(proposal.status,200);
 await f.req('manage/terms',{...terms,command:crypto.randomUUID(),version:2,seller_payout_bps:10000},f.cookies.owner);
 const pending=(await f.req('order/view',{id:created.data.id,key:created.data.key})).data;
 const approval=await f.req('order/approve',{id:created.data.id,key:created.data.key,version:pending.version,proposal_id:pending.proposal.id,approved:true});
 assert.equal(approval.data.error,'MARGIN_BELOW_MINIMUM');
 assert.equal(f.db.sqlite.prepare('SELECT total FROM orders WHERE id=?').get(created.data.id).total,1000);

 }finally{f.db.close()}
});
