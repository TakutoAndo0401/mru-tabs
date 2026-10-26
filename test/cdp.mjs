import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launch() {
  const profile = await mkdtemp(join(tmpdir(), 'mru-tabs-test-'));
  const process = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--user-data-dir=${profile}`, '--headless=new', '--screen-info={1600x1100}', '--window-size=1440,940', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-domain-reliability', '--no-pings',
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let buffer = '', counter = 0, errors = '';
  const pending = new Map(), events = [];
  process.on('error', error => { errors += error.message; });
  process.stderr.on('data', data => { errors += data; });
  process.stdio[4].on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0,end));
      buffer = buffer.slice(end+1);
      if (message.method) events.push(message);
      if (message.id && pending.has(message.id)) {
        const {resolve,reject,timer} = pending.get(message.id);
        clearTimeout(timer); pending.delete(message.id);
        if (message.error) reject(Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    }
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve,reject) => {
      const id = ++counter;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout ${method}: ${errors.slice(-1000)}`)); },15000);
      pending.set(id,{resolve,reject,timer});
      process.stdio[3].write(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})})+'\0');
    });
  }
  return { profile, send, events, async close() {
    try { await send('Browser.close'); } catch {}
    if (process.exitCode === null && process.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => {process.kill(); resolve();},3000);
      process.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await rm(profile,{recursive:true,force:true});
  } };
}

export async function evaluate(browser, sessionId, expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true, userGesture:true },sessionId);
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
