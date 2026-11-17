import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
/** Execute npm's JS entry through Node, never npm.cmd or a shell. */
export function npmCli({platform=process.platform,executable=process.execPath,env=process.env,exists=existsSync,realpath=realpathSync}={}){
  const p=platform==='win32'?path.win32:path.posix;
  const candidates=[env.npm_execpath,p.join(p.dirname(executable),'node_modules/npm/bin/npm-cli.js'),p.resolve(p.dirname(executable),'../lib/node_modules/npm/bin/npm-cli.js')];
  for(const directory of (env.PATH??'').split(p.delimiter).filter(value=>p.isAbsolute(value)))candidates.push(p.join(directory,'node_modules/npm/bin/npm-cli.js'),p.join(directory,'npm'));
  for(const candidate of candidates)if(candidate&&p.isAbsolute(candidate)&&exists(candidate)){const resolved=realpath(candidate);if(/[\\/]npm-cli\.js$/.test(resolved))return resolved;}
  throw new Error('npm JavaScript entry is unavailable. Install Node/npm or invoke through npm with npm_execpath. No shell fallback is used.');
}
