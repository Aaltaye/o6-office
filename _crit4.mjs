import { createBridge } from './bridge/server.mjs';
const token = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const bridge = createBridge({ token, port: 4199 });
console.log('bridge keys:', Object.keys(bridge));
