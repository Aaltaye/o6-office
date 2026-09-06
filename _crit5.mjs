import { createBridge } from './bridge/server.mjs';
const token = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const bridge = createBridge({ token, port: 4199, log: () => {} });
await bridge.listen();
process.on('exit', (c) => console.log('PROCESS EXIT code', c));
process.on('uncaughtException', (e) => console.log('uncaughtException:', e.message));
process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e && e.message));

const post = async (body) => {
  const r = await fetch('http://127.0.0.1:4199/hook', { method:'POST', headers:{'x-o6-token':token,'content-type':'application/json'}, body: JSON.stringify(body) });
  return `${r.status} ${await r.text()}`;
};
console.log('1 good:', await post({hook_event_name:'SessionStart'}));
console.log('2 no tool_use_id:', await post({hook_event_name:'PreToolUse', tool_name:'Read', tool_input:{file_path:'/a/b.ts'}}));
console.log('   emitted event:', JSON.stringify(bridge.events.at(-1)));
const { isOfficeEvent } = await import('./lib/office-view/core/events.ts');
console.log('   isOfficeEvent =', isOfficeEvent(bridge.events.at(-1)));
console.log('   after JSON roundtrip =', isOfficeEvent(JSON.parse(JSON.stringify(bridge.events.at(-1)))));
try {
  console.log('3 tool_name=42:', await Promise.race([post({hook_event_name:'PreToolUse', tool_name:42}), new Promise((_,rj)=>setTimeout(()=>rj(new Error('TIMEOUT 3s: no response')),3000))]));
} catch (e) { console.log('3 tool_name=42 ->', e.message); }
try { console.log('4 after-crash health:', await Promise.race([fetch('http://127.0.0.1:4199/health').then(r=>r.text()), new Promise((_,rj)=>setTimeout(()=>rj(new Error('TIMEOUT')),2000))])); }
catch(e) { console.log('4 after-crash health ->', e.message); }
console.log('STILL ALIVE');
await bridge.close();
