/* Fifty synthetic agents, so the crowded case can be looked at rather than imagined. */
const URL = 'http://127.0.0.1:4142/event';
const TOKEN = 'fifty-agent-demo-token';
const DEPTS = ['operations', 'workshop', 'research', 'reading', 'frontdesk', 'approvals'];
const shape = process.argv[2] ?? 'spread';
const now = Date.now();
let seq = 0;
const events = [];
const add = (e) => events.push({ v: 1, id: `demo-${seq}`, seq: seq++, runId: 'fifty', occurredAt: now + seq * 20, source: 'external', ...e });

add({ type: 'run.started', label: 'Fifty concurrent agents' });
for (let i = 0; i < 50; i += 1) {
  const worker = `agent:demo${String(i).padStart(2, '0')}`;
  const station = shape === 'one' ? 'operations' : DEPTS[i % DEPTS.length];
  add({ type: 'specialist.joined', label: 'Joined for a bounded assignment', worker, role: 'Explorer' });
  add({ type: 'assignment.started', label: `Bash: task ${i}`, station, worker });
}
const res = await fetch(URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-o6-token': TOKEN },
  body: JSON.stringify(events),
});
console.log(res.status, (await res.text()).slice(0, 300));
