import path from 'node:path';
import {spawn} from 'node:child_process';

const DEVICE_URL='https://auth.openai.com/codex/device';
const MAX_OUTPUT=16*1024;
// Never log or expose child output: only the two explicitly labelled device fields survive.
export async function startCodexDeviceLogin(root,{spawnProcess=spawn}={}){
 let child,status='wait',message='',url='',userCode='',buffer='',outputBytes=0,settled=false,closed=false;
 let readyResolve,readyReject,closeResolve;
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const done=new Promise(resolve=>{closeResolve=resolve;});
 let readyTimer,lifetimeTimer,killTimer;
 const failReady=()=>{if(!settled){settled=true;readyReject(Error('设备码登录启动失败，请重试'));}};
 const terminate=()=>{
  if(closed||!child)return;
  try{child.kill('SIGTERM');}catch{}
  if(!killTimer){killTimer=setTimeout(()=>{if(!closed)try{child.kill('SIGKILL');}catch{}},2000);killTimer.unref();}
 };
 const fail=(text)=>{if(status==='wait'){status='error';message=text;}buffer='';failReady();terminate();};
 const receive=chunk=>{
  outputBytes+=chunk.length;
  if(outputBytes>MAX_OUTPUT){fail('设备码登录输出异常，请重新登录');return;}
  if(status!=='wait'||settled)return;
  buffer=(buffer+chunk.toString('utf8')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  const foundURL=buffer.match(/Codex device URL:[ \t]*(https:\/\/auth\.openai\.com\/codex\/device)(?=\s|$)/);
  const foundCode=buffer.match(/Codex device code:[ \t]*([A-Z0-9]{4}-[A-Z0-9]{4,8})[ \t]*(?=\r?\n)/);
  if(foundURL)url=DEVICE_URL;
  if(foundCode)userCode=foundCode[1];
  if(url&&userCode){settled=true;buffer='';clearTimeout(readyTimer);readyResolve();}
 };
 try{
  child=spawnProcess(path.join(root,'cli-proxy-api'),['-config',path.join(root,'config.yaml'),'-codex-device-login','-no-browser'],{cwd:root,stdio:['ignore','pipe','pipe'],detached:false,windowsHide:true});
  child.stdout.on('data',receive);child.stderr.on('data',receive);
  child.once('error',()=>{fail('设备码登录进程启动失败，请重试');});
  child.once('close',code=>{
   closed=true;clearTimeout(readyTimer);clearTimeout(lifetimeTimer);clearTimeout(killTimer);buffer='';
   if(status==='wait'){
    if(code===0&&settled){status='ok';message='';}
    else{status='error';message='设备码登录未完成，请重新登录';}
   }
   failReady();closeResolve();
  });
  readyTimer=setTimeout(()=>fail('设备码登录启动超时，请重试'),30000);readyTimer.unref();
  lifetimeTimer=setTimeout(()=>fail('设备码已过期，请重新登录'),15*60*1000);lifetimeTimer.unref();
  await ready;
  return {
   url,userCode,
   snapshot:()=>({status,message}),
   cancel:async()=>{if(status==='wait'){status='error';message='授权已取消';}buffer='';terminate();await done;},
  };
 }catch{
  clearTimeout(readyTimer);clearTimeout(lifetimeTimer);buffer='';terminate();
  throw Error('设备码登录启动失败，请重试');
 }
}
