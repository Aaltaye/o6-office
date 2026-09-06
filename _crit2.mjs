import { deskForTool, mapHook, TOOL_DESKS } from './bridge/map-claude-code.mjs';
const show = (v) => { try { const r = deskForTool(v); console.log('deskForTool', JSON.stringify(String(v)), '->', typeof r, String(r).slice(0,40)); } catch (e) { console.log('deskForTool', JSON.stringify(String(v)), '-> THREW', e.constructor.name, e.message); } };
show('constructor'); show('toString'); show('valueOf'); show('__proto__'); show('hasOwnProperty');
show(42); show(null); show(undefined); show(''); show(0);
try { console.log('obj:', deskForTool({})); } catch(e){ console.log('deskForTool({}) THREW', e.message); }
try { console.log('arr:', deskForTool([])); } catch(e){ console.log('deskForTool([]) THREW', e.message); }
console.log('MCP__Foo__bar ->', deskForTool('MCP__Foo__bar'));
console.log('mcp__Control_Chrome__open_url ->', deskForTool('mcp__Control_Chrome__open_url'));
console.log('mcp__visualize__show_widget ->', deskForTool('mcp__visualize__show_widget'));
console.log('--- mapHook constructor hook ---');
console.log(JSON.stringify(mapHook({hook_event_name:'constructor'})).slice(0,200));
console.log('--- mapHook PreToolUse tool_name=42 ---');
try { console.log(JSON.stringify(mapHook({hook_event_name:'PreToolUse', tool_name:42}))); } catch(e){ console.log('THREW', e.message); }
console.log('--- mapHook SessionStart with tool_name=42 ---');
try { console.log(JSON.stringify(mapHook({hook_event_name:'SessionStart', tool_name:42}))); } catch(e){ console.log('THREW', e.message); }
console.log('--- PreToolUse no tool_use_id ---');
console.log(JSON.stringify(mapHook({hook_event_name:'PreToolUse', tool_name:'Read', tool_input:{file_path:'/a/b.txt'}})));
console.log('has id key?', 'id' in mapHook({hook_event_name:'PreToolUse', tool_name:'Read'}).events[0]);
console.log('--- describeTool hijack ---');
const long='x'.repeat(264);
console.log(JSON.stringify(mapHook({hook_event_name:'PreToolUse', tool_name:'mcp__cal__create_event', tool_input:{description: long}}).events[0].label).length, 'chars');
console.log(JSON.stringify(mapHook({hook_event_name:'PreToolUse', tool_name:'Bash', tool_input:{command:'line1\nline2\nline3'}}).events[0].label));
console.log('--- tool roster coverage ---');
const exact = Object.keys(TOOL_DESKS.exact);
console.log('exact count', exact.length, exact.join(','));
