import { readFileSync } from 'node:fs';
import { compileFloorPlan } from './lib/office-view/core/plan.ts';
import { schedule } from './lib/office-view/core/scheduler.ts';
import { codingSessionPlan } from './lib/floorplans/coding-session.ts';
import { leadReactivationPlan } from './lib/floorplans/lead-reactivation.ts';

function run(name, plan, file) {
  const events = JSON.parse(readFileSync(file, 'utf8')).events;
  const t = schedule(events, compileFloorPlan(plan), {});
  console.log('===', name, 'duration', t.duration, 'violations', t.violations.length);
  for (const [id, ch] of t.stationBusy) console.log('   station', id, '@end =', JSON.stringify(ch.sampleAt(t.duration)));
  for (const [id, w] of t.workers) console.log('   worker', id, '| role', w.role, '| present', w.present.sampleAt(t.duration), '| status@end', JSON.stringify(w.status.sampleAt(t.duration)), '| station', w.station);
}
run('coding', codingSessionPlan, 'fixtures/recorded-coding-run.json');
run('lead', leadReactivationPlan, 'fixtures/recorded-lead-run.json');
