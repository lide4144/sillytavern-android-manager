import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startCodexDeviceLogin} from './device-login.mjs';
const exec=promisify(execFile);
const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=process.env.ST_MANAGER_ROOT??'/opt/st-subscription-proxy';
const PORT=Number(process.env.ST_MANAGER_PORT??8318);
if(!Number.isInteger(PORT)||PORT<1||PORT>65535)throw Error('Invalid manager port');
const DATA_DIR=process.env.ST_MANAGER_DATA_DIR??HERE;
const ORIGIN='http://127.0.0.1:'+PORT;
const MGMT=process.env.ST_MANAGER_MGMT??'http://127.0.0.1:8317/v8/management';
const GATEWAY=process.env.ST_MANAGER_GATEWAY??'http://127.0.0.1:8317';
const TAVERN=process.env.ST_MANAGER_TAVERN??'http://127.0.0.1:8000';
const DISABLE_SERVICE_ACTIONS=process.env.ST_MANAGER_DISABLE_SERVICE_ACTIONS==='1';
const access=JSON.parse(fs.readFileSync(path.join(ROOT,'local-access.json'),'utf8'));
const local=JSON.parse(fs.readFileSync(path.join(DATA_DIR,'manager-access.json'),'utf8'));
const session=crypto.createHmac('sha256',local.appKey).update('manager-cookie-v1').digest('hex');
const providers=['codex','claude','antigravity'];
const labels={codex:'ChatGPT / Codex',claude:'Claude Pro',antigravity:'Antigravity'};
const prefixes={codex:'codex/',claude:'pro/',antigravity:'agy/'};
const flows=new Map();
const recent=[];
let aliasesPromise=null;
let modelWriteQueue=Promise.resolve();
const oauthQueues=new Map();
const SETTINGS=process.env.ST_MANAGER_SETTINGS_PATH??process.env.ST_MANAGER_SETTINGS_FILE??'/opt/SillyTavern/data/default-user/settings.json';
function conflict(message){const e=Error(message);e.status=409;return e;}
function inOAuthQueue(provider,operation){
 if(!providers.includes(provider))return Promise.reject(Error('不支持此订阅来源'));
 const previous=oauthQueues.get(provider)??Promise.resolve();
 const current=previous.catch(()=>{}).then(operation);
 oauthQueues.set(provider,current);
 current.finally(()=>{if(oauthQueues.get(provider)===current)oauthQueues.delete(provider);}).catch(()=>{});
 return current;
}
function tavernActive(settings){return settings?.main_api==='openai'&&settings?.oai_settings?.chat_completion_source==='custom'&&settings.oai_settings.custom_url===GATEWAY+'/v1';}
function snapshot(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function same(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function headers(extra={}){return {'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",...extra};}
function reply(res,code,body,type='application/json; charset=utf-8',extra={}){res.writeHead(code,headers({'Content-Type':type,...extra}));res.end(type.startsWith('application/json')?JSON.stringify(body):body);}
function clean(s){return String(s??'').replace(/Bearer\s+\S+/gi,'Bearer [hidden]').replace(/(?:sk-|ya29\.)[A-Za-z0-9_\-.]{12,}/g,'[hidden]').replace(/([?&](?:code|access_token|refresh_token|id_token)=)[^&\s]+/g,'$1[hidden]').slice(0,700);}
async function remote(route,{method='GET',body,timeout=15000,signal,ifMatch,withMeta=false}={}){
 const ctrl=AbortSignal.timeout(timeout);
 const r=await fetch(MGMT+route,{method,headers:{Authorization:'Bearer '+access.managementKey,'Content-Type':'application/json',...(ifMatch?{'If-Match':ifMatch}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,ctrl]):ctrl});
 const text=await r.text();let data;try{data=JSON.parse(text);}catch{throw Error('Unexpected gateway response');}
 if(!r.ok){const hints={400:'请求参数未被网关接受',401:'管理认证或登录凭据已失效',403:'网关拒绝了此操作',404:'账号或接口已变更，请刷新',409:'操作状态已变化，请刷新',412:'配置已被其他页面修改，请重试',429:'服务商暂时限流，请稍后重试'};const e=Error((hints[r.status]??'网关操作失败')+'（HTTP '+r.status+'）');e.status=r.status;throw e;}
 return withMeta?{data,etag:r.headers.get('etag')}:data;
}
async function credentials(){const data=await remote('/credentials');return (data.files??[]).filter(c=>providers.includes(c.provider??c.type));}
function id(c){return crypto.createHmac('sha256',local.appKey).update(c.name??c.id??'').digest('hex').slice(0,24);}
async function findCredential(accountId){const all=await credentials();const c=all.find(c=>id(c)===accountId);if(!c){const e=Error('账号已变更，请刷新');e.status=404;throw e;}return c;}
async function gatewayModels(){const r=await fetch(GATEWAY+'/v1/models',{headers:{Authorization:'Bearer '+access.apiKey},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('模型列表 HTTP '+r.status);const d=await r.json();return(d.data??[]).map(m=>({id:m.id,provider:Object.keys(prefixes).find(p=>String(m.id).startsWith(prefixes[p]))??'other'}));}
async function service(name,verb='is-active'){if(DISABLE_SERVICE_ACTIONS)return 'test';try{const r=await exec('/usr/bin/systemctl',[verb,name],{timeout:12000,maxBuffer:8192});return r.stdout.trim();}catch(e){return clean(e.stdout||'inactive');}}
async function readAliases(route){
 try{const result=await remote(route,{withMeta:true});if(!Array.isArray(result.data))throw Error('模型别名配置响应异常');return {...result,exists:true};}
 catch(e){if(e.status!==404)throw e;return {data:[],etag:null,exists:false};}
}
function syncAliases(){
 if(aliasesPromise)return aliasesPromise;
 const work=(async()=>{
  const all=await credentials();const namesByProvider=new Map();
  for(const c of all){if(c.disabled)continue;const p=c.provider??c.type;const r=await remote('/credentials/models?name='+encodeURIComponent(c.name));
   if(!Array.isArray(r.models))throw Error('模型目录响应异常');
   const names=namesByProvider.get(p)??new Set();for(const m of r.models)if(typeof m.id==='string'&&m.id)names.add(m.id);namesByProvider.set(p,names);
  }
  for(const [p,names] of namesByProvider){
   const route='/config/oauth/model-alias/'+encodeURIComponent(p);let complete=false;
   for(let attempt=0;attempt<3;attempt++){
    const before=await readAliases(route);const entries=structuredClone(before.data);
    for(const name of names){if(name.startsWith(prefixes[p])||entries.some(e=>e.name===name||e.alias===name))continue;entries.push({name,alias:prefixes[p]+name,fork:false});}
    if(snapshot(entries)===snapshot(before.data)){complete=true;break;}
    if(!before.etag){const fresh=await readAliases(route);if(fresh.exists!==before.exists||snapshot(fresh.data)!==snapshot(before.data))continue;}
    try{const result=await remote(route,{method:'PUT',body:entries,ifMatch:before.etag});if(result.status!=='ok')throw Error('模型别名保存未确认');complete=true;break;}
    catch(e){if(e.status!==412)throw e;}
   }
   if(!complete)throw conflict('模型配置正在被其他客户端修改，请重试刷新');
  }
 })();
 aliasesPromise=work;work.finally(()=>{if(aliasesPromise===work)aliasesPromise=null;}).catch(()=>{});return work;
}
async function state(){
 const [cs,models,gw,st]=await Promise.all([credentials(),gatewayModels(),service('st-subscription-proxy.service'),service('sillytavern.service')]);
 let selected='',tavernConnectionActive=false;try{const settings=JSON.parse(fs.readFileSync(SETTINGS,'utf8'));tavernConnectionActive=tavernActive(settings);if(tavernConnectionActive)selected=settings.oai_settings.custom_model??'';}catch{}
 return {updatedAt:new Date().toISOString(),services:{gateway:gw,tavern:st},tavernConnectionActive,defaultModel:selected,models,providers:providers.map(p=>({id:p,label:labels[p],modelCount:models.filter(m=>m.provider===p).length,accounts:cs.filter(c=>(c.provider??c.type)===p).map(c=>({id:id(c),label:c.email||labels[p]+' · '+id(c).slice(0,6),status:c.status??'unknown',disabled:!!c.disabled,unavailable:!!c.unavailable,message:c.unavailable?'此账号暂不可用，请刷新凭据或检查订阅限额':'',canRemove:!c.runtime_only,lastRefresh:c.last_refresh??c.last_refreshed_at??null}))})),flows:[...flows.values()].map(f=>({provider:f.provider,kind:f.kind??'browser',status:f.aliasesPending?'wait':f.status,url:f.url,userCode:f.userCode,startedAt:f.startedAt,message:f.message??(f.kind==='device'?f.device.snapshot().message:'')})),recent:recent.slice(-6).reverse(),quotaNote:'不伪造实时剩余额度。状态与限流以服务商实际响应为准。'};
}
async function body(req){let size=0,out='';for await(const part of req){size+=part.length;if(size>65536){const e=Error('请求过大');e.status=413;throw e;}out+=part;}try{return out?JSON.parse(out):{};}catch{const e=Error('JSON 格式错误');e.status=400;throw e;}}
function logAction(type,message){recent.push({time:new Date().toISOString(),type,message:clean(message)});if(recent.length>20)recent.shift();}
function oauthUrl(raw){const u=new URL(raw);if(u.protocol!=='https:'||!['accounts.google.com','claude.ai','console.anthropic.com','auth.openai.com','platform.openai.com'].includes(u.hostname))throw Error('授权站点未在允许列表中');return u.toString();}
async function cancelFlow(f){
 if(!f)return;
 if(f.kind==='device'){await f.device.cancel();return;}
 if(f.status==='wait')await remote('/oauth/session?state='+encodeURIComponent(f.state),{method:'DELETE'});
}
async function startOAuth(provider,mode='browser'){
 if(!providers.includes(provider))throw Error('不支持此订阅来源');
 if(!['browser','device'].includes(mode)||mode==='device'&&provider!=='codex'){const e=Error('不支持此登录方式');e.status=400;throw e;}
 if(mode==='device'&&DISABLE_SERVICE_ACTIONS){const e=Error('测试模式已停用设备码进程');e.status=403;throw e;}
 const old=flows.get(provider);if(old){await cancelFlow(old);flows.delete(provider);}
 if(mode==='device'){
  const device=await startCodexDeviceLogin(ROOT);
  const f={provider,kind:'device',device,url:device.url,userCode:device.userCode,status:'wait',startedAt:new Date().toISOString()};
  flows.set(provider,f);logAction('oauth',labels[provider]+' 设备码授权已启动');
  return {provider,url:f.url,userCode:f.userCode,status:f.status,kind:f.kind};
 }
 const r=await remote('/oauth/auth-url?provider='+provider+'&is_webui=true',{timeout:30000});
 let validatedURL;try{if(r.status!=='ok'||typeof r.state!=='string'||!r.state.trim())throw Error('授权会话响应异常');validatedURL=oauthUrl(r.url);}catch(e){if(typeof r.state==='string'&&r.state)await remote('/oauth/session?state='+encodeURIComponent(r.state),{method:'DELETE'}).catch(()=>{});throw e;}
 const f={provider,state:r.state,url:validatedURL,userCode:r.user_code??'',status:'wait',startedAt:new Date().toISOString()};
 flows.set(provider,f);logAction('oauth',labels[provider]+' 授权已启动');
 return {provider,url:f.url,userCode:f.userCode,status:f.status};
}
async function pollOAuth(provider){
 const f=flows.get(provider);if(!f)return{status:'none'};
 if(f.status==='ok'&&f.aliasesPending)await finishOAuthAliases(f);
 if(f.status!=='wait')return{provider,status:f.status,message:f.message??''};
 const r=f.kind==='device'?f.device.snapshot():await remote('/oauth/status?state='+encodeURIComponent(f.state));
 if(r.status==='ok'){f.status='ok';f.url='';f.userCode='';f.aliasesPending=true;logAction('oauth',labels[provider]+' 登录成功');await finishOAuthAliases(f);}
 else if(r.status==='error'){f.status='error';f.url='';f.userCode='';f.message=clean(r.message??r.error??'授权未完成，请重新登录');logAction('oauth',labels[provider]+' '+f.message);}
 else if(r.status!=='wait')throw Error('授权状态响应异常');
 return {provider,status:f.status,message:f.message??''};
}
async function finishOAuthAliases(f){
 try{await syncAliases();f.aliasesPending=false;f.message='';}
 catch(e){f.message='登录已成功，模型别名同步失败，请刷新模型后重试';throw Error(f.message);}
}
async function tavernSession(){const base=TAVERN;const r=await fetch(base+'/csrf-token',{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('酒馆尚未就绪');const token=(await r.json()).token;const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return {base,headers:{Cookie:cookie,'X-CSRF-Token':token,'Content-Type':'application/json'}};}
async function readTavernSettings(s){
 const r=await fetch(s.base+'/api/settings/get',{method:'POST',headers:s.headers,body:'{}',signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error('读取酒馆设置 HTTP '+r.status);
 const raw=await r.json();const settings=typeof raw.settings==='string'?JSON.parse(raw.settings):raw.settings;
 if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('酒馆设置响应异常，未修改');return settings;
}
function setModel(model){
 const operation=modelWriteQueue.catch(()=>{}).then(()=>setModelExclusive(model));
 modelWriteQueue=operation;return operation;
}
async function setModelExclusive(model){
 const models=await gatewayModels();if(!models.some(m=>m.id===model))throw Error('此模型当前不在网关目录中');
 const s=await tavernSession();const settings=await readTavernSettings(s);
 if(!tavernActive(settings))throw conflict('酒馆已切换其他接口，保留现有设置，请先在酒馆选择本机网关');
 const original=snapshot(settings);const disk=fs.readFileSync(SETTINGS);
 if(snapshot(JSON.parse(disk.toString('utf8')))!==original)throw conflict('酒馆设置已变更，请刷新后重试');
 settings.oai_settings.custom_model=model;
 const fresh=await readTavernSettings(s);
 if(snapshot(fresh)!==original||!disk.equals(fs.readFileSync(SETTINGS)))throw conflict('酒馆设置已被其他页面修改，请刷新后重试');
 const backup=SETTINGS+'.before-manager-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
 fs.writeFileSync(backup,disk,{flag:'wx',mode:0o600});
 const saved=await fetch(s.base+'/api/settings/save',{method:'POST',headers:s.headers,body:JSON.stringify(settings),signal:AbortSignal.timeout(10000)});
 if(!saved.ok)throw Error('保存酒馆设置 HTTP '+saved.status);
 let result;try{result=await saved.json();}catch{throw Error('酒馆保存响应异常，请检查设置');}
 if(result?.result!=='ok')throw Error('酒馆未确认保存成功，请检查设置');
 const confirmed=await readTavernSettings(s);
 if(!tavernActive(confirmed)||confirmed.oai_settings.custom_model!==model)throw conflict('保存后设置校验不一致，请检查酒馆当前连接');
 logAction('model','酒馆默认模型已设为 '+model);return{ok:true,model,message:'已保存并校验。重开酒馆应用后生效；旧页面继续操作可能覆盖设置。'};
}
async function testModel(model,req,res){
 const models=await gatewayModels();if(!models.some(m=>m.id===model))throw Error('请选择目录中存在的模型');
 const controller=new AbortController();const onClose=()=>{if(!res.writableEnded)controller.abort();};res.on('close',onClose);
 const started=Date.now();
 try{
 const r=await fetch(GATEWAY+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+access.apiKey,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'Reply with exactly the word OK.'}],max_tokens:model.includes('gemini')?2048:256,stream:false}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(90000)])});
 const d=await r.json();const text=d.choices?.[0]?.message?.content??'';const ok=r.ok&&!d.error&&!!text.trim();const result={ok,model,http:r.status,elapsedMs:Date.now()-started,text:ok?text.slice(0,1000):'',message:ok?'模型响应正常':clean(d.error?.message??d.error??'返回了空回复')};logAction('test',model+' '+(ok?'测试成功':result.message));return result;
 }finally{res.off('close',onClose);}
}
const server=http.createServer(async(req,res)=>{
 try{
 const host=req.headers.host;if(!['127.0.0.1:'+PORT,'localhost:'+PORT].includes(host)){reply(res,421,{error:'Invalid host'});return;}
 const url=new URL(req.url,ORIGIN);
 if(url.pathname==='/bootstrap'){
  if(req.method!=='GET'||!same(req.headers['x-app-key'],local.appKey)){reply(res,401,{error:'请从订阅管理应用打开'});return;}
  res.writeHead(303,headers({'Set-Cookie':`st_manager=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,Location:'/'}));res.end();return;
 }
 const cookies=String(req.headers.cookie??'').split(';').map(x=>x.trim());if(!cookies.some(c=>same(c,'st_manager='+session))){reply(res,401,{error:'请从手机的订阅管理应用打开，或重新打开应用以建立会话'});return;}
 if(req.method!=='GET'){
  if(req.headers.origin!==ORIGIN||req.headers['x-st-manager']!=='1'||!String(req.headers['content-type']??'').startsWith('application/json')){reply(res,403,{error:'请求来源校验失败'});return;}
 }
 if(req.method==='GET'&&url.pathname==='/api/state'){reply(res,200,await state());return;}
 if(req.method==='GET'&&url.pathname==='/api/diagnostics/download'){
  const s=await state();const report={createdAt:s.updatedAt,services:s.services,defaultModel:s.defaultModel,providers:s.providers.map(p=>({provider:p.id,accounts:p.accounts.length,enabled:p.accounts.filter(a=>!a.disabled).length,modelCount:p.modelCount})),notes:['No passwords, OAuth credentials or management keys included.','Quota values are not estimated.']};reply(res,200,report,'application/json; charset=utf-8',{'Content-Disposition':'attachment; filename="subscription-manager-diagnostics.json"'});return;
 }
 if(req.method==='GET'&&['/','/app.js','/style.css'].includes(url.pathname)){
  const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);const type=filename.endsWith('.js')?'text/javascript; charset=utf-8':filename.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';reply(res,200,fs.readFileSync(path.join(HERE,'public',filename)),type);return;
 }
 if(req.method==='POST'){
  const b=await body(req);let result;
  switch(url.pathname){
   case '/api/oauth/start':result=await inOAuthQueue(b.provider,()=>startOAuth(b.provider,b.mode??'browser'));break;
   case '/api/oauth/status':result=await inOAuthQueue(b.provider,()=>pollOAuth(b.provider));break;
   case '/api/oauth/cancel':result=await inOAuthQueue(b.provider,async()=>{const f=flows.get(b.provider);await cancelFlow(f);flows.delete(b.provider);return {ok:true};});break;
   case '/api/oauth/callback':result=await inOAuthQueue(b.provider,async()=>{const f=flows.get(b.provider);if(!f||f.status!=='wait'||f.kind==='device')throw Error('没有等待中的浏览器授权，请先点击重新登录');const u=new URL(String(b.redirectUrl??''));const expected=new URL(new URL(f.url).searchParams.get('redirect_uri'));if(u.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.port!==expected.port||u.pathname!==expected.pathname||u.searchParams.get('state')!==f.state)throw Error('回调地址与当前授权不匹配，请粘贴浏览器最终完整地址');await remote('/oauth/callback',{method:'POST',body:{provider:b.provider,redirect_url:u.toString()}});return {ok:true};});break;
   case '/api/account/refresh':{const c=await findCredential(b.id);await remote('/credentials/refresh',{method:'POST',body:{name:c.name},timeout:40000});logAction('account',labels[c.provider??c.type]+' 凭据已刷新');result={ok:true};break;}
   case '/api/account/toggle':{const c=await findCredential(b.id);await remote('/credentials/status',{method:'PATCH',body:{name:c.name,disabled:!!b.disabled}});logAction('account',(b.disabled?'已暂停 ':'已启用 ')+labels[c.provider??c.type]);result={ok:true};break;}
   case '/api/account/delete':{if(b.confirm!==true)throw Error('请先确认移除账号');const c=await findCredential(b.id);await remote('/credentials?name='+encodeURIComponent(c.name),{method:'DELETE'});logAction('account','已移除 '+labels[c.provider??c.type]+' 的一个本机账号');result={ok:true};break;}
   case '/api/access/reveal':{if(b.confirm!==true){const e=Error('请确认查看本机网关凭据');e.status=400;throw e;}if(!['api','management'].includes(b.kind)){const e=Error('请选择 API 密钥或管理密码');e.status=400;throw e;}const key=b.kind==='api'?access.apiKey:access.managementKey;if(typeof key!=='string'||!key)throw Error('本机未保存该凭据，请检查部署配置');result={kind:b.kind,value:key,baseURL:GATEWAY+'/v1',managementURL:GATEWAY+'/management.html'};break;}
    case '/api/models/refresh':await syncAliases();result={ok:true};break;
   case '/api/tavern/model':result=await setModel(String(b.model??''));break;
   case '/api/model/test':if(b.confirm!==true)throw Error('测试会消耗少量订阅额度，请先确认');result=await testModel(String(b.model??''),req,res);break;
   case '/api/service/restart':{if(DISABLE_SERVICE_ACTIONS){const e=Error('测试模式已停用服务操作');e.status=403;throw e;}if(b.confirm!==true)throw Error('请确认重启');const name={gateway:'st-subscription-proxy.service',tavern:'sillytavern.service'}[b.service];if(!name)throw Error('未知服务');await exec('/usr/bin/systemctl',['restart',name],{timeout:25000,maxBuffer:8192});logAction('service','已重启 '+b.service);result={ok:true};break;}
   default:reply(res,404,{error:'Not found'});return;
  }
  reply(res,200,result);return;
 }
 reply(res,404,{error:'Not found'});
 }catch(e){if(!res.headersSent&&!res.destroyed)reply(res,e.status&&e.status>=400&&e.status<600?e.status:500,{error:clean(e.message??e)});}
});
server.requestTimeout=100000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
server.listen(PORT,'127.0.0.1',()=>console.log('Subscription Manager ready on '+ORIGIN+' (authenticated local access only)'));
