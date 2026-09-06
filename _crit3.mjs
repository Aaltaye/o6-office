import { mapHook } from './bridge/map-claude-code.mjs';
const r = mapHook({hook_event_name:'constructor'});
console.log('ignored typeof =', typeof r.ignored, '| === "unknown hook"?', r.ignored === 'unknown hook');
const r2 = mapHook({hook_event_name:'toString'});
console.log('toString ignored typeof =', typeof r2.ignored);
const r3 = mapHook({hook_event_name:'SomeFutureHook'});
console.log('future ignored =', JSON.stringify(r3.ignored));
