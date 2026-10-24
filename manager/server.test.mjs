import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const parse=async req=>{let s='';for await(const c of req)s+=c;return s?JSON.parse(s):{};};
test('subscription manager contracts with isolated fake providers',async t=>{
 const dir=fs.mkdtempSync(path.join(HERE,'.test-run-'));
 const SENTINEL='DO_NOT_EXPOSE_PROVIDER_REFRESH_TOKEN_SENTINEL';
 const APPKEY='fake-app-key-for-tests-only';
 const settingsFile=path.join(dir,'settings.json');
 const rows=['codex','claude','antigravity'].map(p=>({name:p+'-fixture.json',provider:p,email:p+'@example.test',status:'ready',disabled:false,runtime_only:false,account:SENTINEL,path:SENTINEL,status_message:SENTINEL,metadata:{refresh_token:SENTINEL}}));
 let settings,saveFailure=false,generated=0,refreshes=0,deletions=0,cancelled=0,serial=0;
 const sessions=new Map();const aliases={codex:[{name:'gpt-test',alias:'codex/gpt-test',fork:false}],claude:[],antigravity:[]};let revision=1;
 const up=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://fake');const json=(value,code=200,h={})=>{res.writeHead(code,{'Content-Type':'application/json',...h});res.end(JSON.stringify(value));};
  try{
   if(u.pathname==='/v1/models')return json({data:[{id:'codex/gpt-test'},{id:'pro/claude-test'},{id:'agy/gemini-test'}]});
   if(u.pathname==='/v1/chat/completions'){generated++;return json({choices:[{message:{content:'OK'}}]});}
   if(u.pathname==='/tavern/csrf-token')return json({token:'fixture-csrf'},200,{'Set-Cookie':'fixture=session; HttpOnly'});
   if(u.pathname==='/tavern/api/settings/get')return json({settings:JSON.stringify(settings)});
   if(u.pathname==='/tavern/api/settings/save'){const b=await parse(req);if(saveFailure)return json({error:'simulated write failure'});settings=b;fs.writeFileSync(settingsFile,JSON.stringify(settings));return json({result:'ok'});}
   const route=u.pathname.replace('/v8/management','');
   if(req.headers.authorization!=='Bearer fake-management-key')return json({error:'bad management key'},401);
   if(route==='/credentials'&&req.method==='GET')return json({files:rows});
   if(route==='/credentials/models'){const name=u.searchParams.get('name');return json({models:[{id:name.startsWith('codex')?'gpt-test':name.startsWith('claude')?'claude-test':'gemini-test'}]});}
   if(route==='/credentials/status'){const b=await parse(req);const row=rows.find(c=>c.name===b.name);if(!row)return json({error:'missing'},404);row.disabled=b.disabled;return json({status:'ok'});}
   if(route==='/credentials/refresh'){refreshes++;return json({ok:true,auth:{metadata:{access_token:SENTINEL}}});}
   if(route==='/credentials'&&req.method==='DELETE'){deletions++;const i=rows.findIndex(c=>c.name===u.searchParams.get('name'));if(i>=0)rows.splice(i,1);return json({status:'ok'});}
   if(route.startsWith('/config/oauth/model-alias/')){const p=route.split('/').at(-1);if(req.method==='GET')return json(aliases[p]??[],200,{ETag:'"'+revision+'"'});if(req.headers['if-match']&&req.headers['if-match']!=='"'+revision+'"')return json({error:'stale'},412);aliases[p]=await parse(req);revision++;return json({status:'ok'});}
   if(route==='/oauth/auth-url'){const provider=u.searchParams.get('provider');const state='fixture-state-'+(++serial);sessions.set(state,{provider,status:'wait'});return json({status:'ok',state,url:'https://'+(provider==='codex'?'auth.openai.com':provider==='claude'?'claude.ai':'accounts.google.com')+'/authorize?redirect_uri='+encodeURIComponent('http://localhost:1455/auth/callback')+'&state='+state});}
   if(route==='/oauth/status'){const s=sessions.get(u.searchParams.get('state'));return json({status:s?.status??'error'});}
   if(route==='/oauth/session'){const s=sessions.get(u.searchParams.get('state'));if(s?.status==='wait'){s.status='error';cancelled++;}return json({status:'ok',cancelled:true});}
   if(route==='/oauth/callback'){const b=await parse(req);const cb=new URL(b.redirect_url);const s=sessions.get(cb.searchParams.get('state'));if(!s)return json({error:'unknown state'},404);s.status='ok';return json({status:'ok'});}
   json({error:'not found'},404);
  }catch(e){json({error:e.message},500);}
 });
 const upPort=await listen(up);const upstream='http://127.0.0.1:'+upPort;
 settings={main_api:'openai',oai_settings:{chat_completion_source:'custom',custom_url:upstream+'/v1',custom_model:'codex/gpt-test'},preserve:'untouched'};
 fs.writeFileSync(settingsFile,JSON.stringify(settings));fs.writeFileSync(path.join(dir,'local-access.json'),JSON.stringify({apiKey:'fake-client-key',managementKey:'fake-management-key'}));fs.writeFileSync(path.join(dir,'manager-access.json'),JSON.stringify({appKey:APPKEY}));
 const reserve=http.createServer();const port=await listen(reserve);await new Promise(r=>reserve.close(r));const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,[path.join(HERE,'server.mjs')],{stdio:'inherit',env:{...process.env,ST_MANAGER_ROOT:dir,ST_MANAGER_DATA_DIR:dir,ST_MANAGER_PORT:String(port),ST_MANAGER_MGMT:upstream+'/v8/management',ST_MANAGER_GATEWAY:upstream,ST_MANAGER_TAVERN:upstream+'/tavern',ST_MANAGER_SETTINGS_PATH:settingsFile,ST_MANAGER_DISABLE_SERVICE_ACTIONS:'1'}});
 t.after(async()=>{child.kill();await new Promise(r=>up.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<50;i++){try{await fetch(base);ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}assert.ok(ready,'test manager starts');
 let cookie='';
 async function call(route,data,override={}){const r=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{Cookie:cookie,...(data===undefined?{}:{Origin:base,'X-ST-Manager':'1','Content-Type':'application/json'}),...override},body:data===undefined?undefined:JSON.stringify(data)});return{status:r.status,data:await r.json()};}
 await t.test('rejects unauthenticated and wrong bootstrap keys',async()=>{assert.equal((await fetch(base+'/api/state')).status,401);assert.equal((await fetch(base+'/bootstrap',{headers:{'X-App-Key':'wrong'},redirect:'manual'})).status,401);});
 await t.test('bootstrap creates HttpOnly strict cookie without exposing key',async()=>{const r=await fetch(base+'/bootstrap',{headers:{'X-App-Key':APPKEY},redirect:'manual'});assert.equal(r.status,303);const c=r.headers.get('set-cookie');assert.match(c,/HttpOnly/);assert.match(c,/SameSite=Strict/);assert.ok(!c.includes(APPKEY));cookie=c.split(';')[0];const page=await fetch(base+'/',{headers:{Cookie:cookie}});assert.equal(page.status,200);assert.ok(!(await page.text()).includes(APPKEY));});
 let first;
 await t.test('state projects metadata and never forwards credential fields',async()=>{const r=await call('/api/state');assert.equal(r.status,200);assert.equal(r.data.providers.length,3);assert.equal(r.data.defaultModel,'codex/gpt-test');assert.ok(!JSON.stringify(r.data).includes(SENTINEL));first=r.data.providers[0].accounts[0].id;assert.equal(generated,0);});
 await t.test('cross-origin mutation is rejected',async()=>{const r=await call('/api/account/toggle',{id:first,disabled:true},{Origin:'https://attacker.example'});assert.equal(r.status,403);assert.equal(rows[0].disabled,false);});
 await t.test('account toggle is reversible and refresh strips auth response',async()=>{assert.equal((await call('/api/account/toggle',{id:first,disabled:true})).status,200);assert.equal(rows[0].disabled,true);await call('/api/account/toggle',{id:first,disabled:false});const r=await call('/api/account/refresh',{id:first});assert.equal(r.status,200);assert.equal(refreshes,1);assert.ok(!JSON.stringify(r).includes(SENTINEL));});
 await t.test('delete and generation require explicit confirmation',async()=>{assert.ok((await call('/api/account/delete',{id:first})).status>=400);assert.equal(deletions,0);assert.ok((await call('/api/model/test',{model:'codex/gpt-test'})).status>=400);assert.equal(generated,0);});
 await t.test('confirmed test uses chosen model and has no auto-fallback',async()=>{const r=await call('/api/model/test',{model:'codex/gpt-test',confirm:true});assert.equal(r.status,200);assert.equal(r.data.text,'OK');assert.equal(r.data.ok,true);assert.equal(generated,1);});
 await t.test('model changes preserve settings and verify save contract',async()=>{let r=await call('/api/tavern/model',{model:'pro/claude-test'});assert.equal(r.status,200,JSON.stringify(r));assert.equal(settings.oai_settings.custom_model,'pro/claude-test');assert.equal(settings.preserve,'untouched');saveFailure=true;r=await call('/api/tavern/model',{model:'codex/gpt-test'});assert.ok(r.status>=400);assert.equal(settings.oai_settings.custom_model,'pro/claude-test');saveFailure=false;settings.oai_settings.chat_completion_source='openai';fs.writeFileSync(settingsFile,JSON.stringify(settings));r=await call('/api/tavern/model',{model:'codex/gpt-test'});assert.equal(r.status,409);settings.oai_settings.chat_completion_source='custom';fs.writeFileSync(settingsFile,JSON.stringify(settings));});
 await t.test('OAuth callback validates current state and cancellation is explicit',async()=>{const start=await call('/api/oauth/start',{provider:'codex'});assert.equal(start.status,200);const url=new URL(start.data.url),state=url.searchParams.get('state');let r=await call('/api/oauth/callback',{provider:'codex',redirectUrl:'http://evil.example:1455/auth/callback?state='+state+'&code=fixture'});assert.ok(r.status>=400);r=await call('/api/oauth/callback',{provider:'codex',redirectUrl:'http://localhost:1455/auth/callback?state='+state+'&code=fixture'});assert.equal(r.status,200);r=await call('/api/oauth/status',{provider:'codex'});assert.equal(r.data.status,'ok');await call('/api/oauth/start',{provider:'claude'});r=await call('/api/oauth/cancel',{provider:'claude'});assert.equal(r.status,200);assert.ok(cancelled>=1);});
 await t.test('concurrent OAuth starts cancel old flow and retain one current flow',async()=>{await Promise.all([call('/api/oauth/start',{provider:'antigravity'}),call('/api/oauth/start',{provider:'antigravity'})]);const pending=[...sessions.values()].filter(s=>s.provider==='antigravity'&&s.status==='wait');assert.equal(pending.length,1);await call('/api/oauth/cancel',{provider:'antigravity'});});
 await t.test('key reveal requires explicit confirmation and rejects cross-origin requests',async()=>{assert.equal((await call('/api/access/reveal',{kind:'api'})).status,400);assert.equal((await call('/api/access/reveal',{kind:'oauth',confirm:true})).status,400);assert.equal((await call('/api/access/reveal',{kind:'api',confirm:true},{Origin:'https://attacker.example'})).status,403);assert.equal((await fetch(base+'/api/access/reveal')).status,401);const a=await call('/api/access/reveal',{kind:'api',confirm:true});assert.equal(a.data.value,'fake-client-key');const m=await call('/api/access/reveal',{kind:'management',confirm:true});assert.equal(m.data.value,'fake-management-key');const s=JSON.stringify((await call('/api/state')).data);assert.ok(!s.includes('fake-client-key'));assert.ok(!s.includes('fake-management-key'));const d=JSON.stringify((await call('/api/diagnostics/download')).data);assert.ok(!d.includes('fake-client-key'));assert.ok(!d.includes('fake-management-key'));});
 await t.test('diagnostics contain counts, not identities or secrets',async()=>{const r=await call('/api/diagnostics/download');assert.equal(r.status,200);const text=JSON.stringify(r.data);assert.ok(!text.includes(SENTINEL));assert.ok(!text.includes('@example.test'));assert.equal(r.data.providers.length,3);});
 await t.test('test environment blocks system service mutations and real device login',async()=>{assert.equal((await call('/api/service/restart',{service:'gateway',confirm:true})).status,403);assert.equal((await call('/api/oauth/start',{provider:'codex',mode:'device'})).status,403);});
});
