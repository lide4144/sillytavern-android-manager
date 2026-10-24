// Source-distribution check. No file contents or matched values are printed.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const errors=[];let files=0;
const forbiddenDirs=new Set(['signing','auth','data','backups','st-backups','logs','out','gen','classes','node_modules']);
const forbiddenNames=new Set(['local-access.json','manager-access.json','manager-config.json','config.yaml','password.txt','secrets.json','settings.json']);
const forbiddenExt=/\.(apk|idsig|jks|keystore|p12|pfx|pem|key|png|jpg|jpeg|webp|zip|tar|gz|dex|class|log)$/i;
const rules=[
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['provider token',/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
 ['JWT',/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
 ['personal email',/\b[A-Za-z0-9._%+-]+@(?!(?:example\.(?:com|test|org)|localhost)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
 ['Windows user path',/[A-Za-z]:[\\/]Users[\\/](?!USERNAME(?:[\\/]|\b)|PUBLIC(?:[\\/]|\b)|\[)[A-Za-z0-9_.-]+/i],
 ['Linux user path',/\/home\/(?!USERNAME(?:\/|\b)|\[|<)[a-zA-Z0-9_.-]+/],
 ['specific CGNAT endpoint',/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
 ['credential literal',/["'](?:access_token|refresh_token|id_token|managementKey|apiKey|appKey)["']\s*:\s*["'](?!REPLACE_[A-Z_]+["'])[A-Za-z0-9_+\/.=-]{24,}["']/],
];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name==='.git')continue;const full=path.join(dir,e.name);const rel=path.relative(root,full).split(path.sep).join('/');if(e.isSymbolicLink()){errors.push(rel+': symlink excluded from public source');continue;}if(e.isDirectory()){if(forbiddenDirs.has(e.name)||e.name.startsWith('.test-run-')){errors.push(rel+': runtime/build directory present');continue;}walk(full);continue;}files++;if(forbiddenNames.has(e.name)||forbiddenExt.test(e.name)||e.name.startsWith('.env')&&e.name!=='.env.example'){errors.push(rel+': private or generated artifact');continue;}const data=fs.readFileSync(full);if(data.includes(0)){errors.push(rel+': binary artifact');continue;}const text=data.toString('utf8');for(const [kind,re]of rules)if(re.test(text))errors.push(rel+': '+kind);}}
walk(root);
if(errors.length){console.error('Privacy check FAILED ('+errors.length+' findings):');for(const e of errors)console.error('- '+e);process.exitCode=1;}
else console.log('Privacy check passed: '+files+' source/document files; no private runtime, signing, identity or token artifacts detected.');
