export type RawLead = { name:string; company:string; email:string; last_contact:string; next_followup:string; opted_out:string; active_customer:string; stage:string; notes:string; row:number };
export type Lead = RawLead & { id:string; sources:RawLead[]; state:'queued'|'ready'|'hold'|'excluded'; reason:string; summary:string; subject:string; draft:string; evidence:string[]; review:'pending'|'approved'|'held'; processed:boolean; aiError?:string };
export type Department = 'Records'|'Context'|'Research'|'Opportunity'|'Outreach'|'Review';
export type WorkEvent = {id:string; at:string; department:Department; leadId?:string; title:string; detail:string; kind:'started'|'completed'|'warning'; tokens?:number};
export const SAMPLE_DATE='2026-09-06';
export const DEFAULT_OFFER='O6 Applied helps businesses improve repetitive administrative workflows, beginning with a short discovery session and a scoped pilot.';
export const SAMPLE_CSV=`name,company,email,last_contact,next_followup,opted_out,active_customer,stage,notes
Mara Ellis,Harbor & Pine,mara@harborandpine.example,2026-07-20,2026-09-01,false,false,Paused,"Wanted to reduce manual inquiry routing. Asked us to reconnect in September after the summer rush."
Dev Shah,Northline Print,dev@northlineprint.example,2026-07-10,2026-08-31,false,false,Paused,"Requested a small pilot to organize quote requests. Asked for a follow-up at the end of August."
Ari Chen,Kindred Studio,ari@kindredstudio.example,2026-05-14,,false,false,Old inquiry,"Met at an event. No additional notes."
Imani Reed,Cedar Supply,imani.cedarsupply,2026-04-09,2026-09-01,false,false,Paused,"Interested in reducing duplicate order entry. Asked for a September follow-up."
Theo Brooks,Fieldwork Services,theo@fieldworkservices.example,2026-06-03,,true,false,Closed,"Asked to receive no further outreach."
Lena Ortiz,Studio Vale,lena@studiovale.example,2026-08-01,,false,true,Customer,"Current customer with an active onboarding project."
Mara Ellis,Harbor & Pine, MARA@HARBORANDPINE.EXAMPLE ,2026-07-22,2026-09-01,false,false,Paused,"Follow-up note: start with a single shared inbox."
Noah Patel,Elm Street Fitness,noah@elmstreetfitness.example,2026-07-15,2026-11-01,false,false,Paused,"Interested in inquiry follow-up. Explicitly asked us to wait until November."
Zoe Martin,Juniper Events,zoe@juniperevents.example,2026-05-02,,false,false,Closed,"Confirmed the service is not relevant to their current business."
Sam Okafor,Westhaven Repairs,sam@westhavenrepairs.example,2025-01-12,2025-03-01,false,false,Paused,"Previously explored appointment reminders. Asked for a March 2025 follow-up; no later records."`;
const aliases:Record<string,string>={full_name:'name',contact_name:'name',contact:'name',email_address:'email',business:'company',company_name:'company',last_contact_date:'last_contact',last_contacted:'last_contact',follow_up_date:'next_followup',next_follow_up:'next_followup',next_follow_up_date:'next_followup',next_followup_date:'next_followup',unsubscribed:'opted_out',do_not_contact:'opted_out',is_customer:'active_customer',status:'stage',description:'notes'};
export function parseCSV(text:string):RawLead[]{
 if(text.length>250000)throw new Error('Please use a CSV smaller than 250 KB.');
 const matrix:string[][]=[];let row:string[]=[],cell='',quoted=false,afterQuote=false;
 text=text.replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;afterQuote=true;}}else cell+=c;continue;}
  if(c==='"'){if(cell.trim()||afterQuote)throw new Error(`Unexpected quote in record ${matrix.length+1}.`);quoted=true;continue;}
  if(c===','||c==='\n'||c==='\r'){row.push(cell.trim());cell='';afterQuote=false;if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(Boolean))matrix.push(row);row=[];}continue;}
  if(afterQuote&&!/\s/.test(c))throw new Error(`Unexpected text after a quote in record ${matrix.length+1}.`);cell+=c;
 }
 if(quoted)throw new Error('A quoted field is not closed. Check the end of your CSV.');
 row.push(cell.trim());if(row.some(Boolean))matrix.push(row);
 if(matrix.length<2)throw new Error('Include a header and at least one lead.');
 if(matrix.length>26)throw new Error('This prototype supports up to 25 records per run.');
 const headers=matrix.shift()!.map(h=>{const k=h.toLowerCase().replace(/[\s-]+/g,'_');return aliases[k]||k;});
 if(new Set(headers).size!==headers.length)throw new Error('Two columns map to the same field. Use one column per field.');
 for(const key of ['name','email','notes'])if(!headers.includes(key))throw new Error(`Missing required column: ${key}. Download the sample for the accepted format.`);
 return matrix.map((values,i)=>{if(values.length!==headers.length)throw new Error(`Record ${i+2} has ${values.length} fields; expected ${headers.length}. Check commas and quotes.`);const r={name:'',company:'',email:'',last_contact:'',next_followup:'',opted_out:'',active_customer:'',stage:'',notes:'',row:i+2};headers.forEach((h,j)=>{if(h in r&&h!=='row')(r as unknown as Record<string,unknown>)[h]=values[j];});if(!r.name)r.name='Unnamed contact';if(r.notes.length>6000)throw new Error(`Record ${i+2}: notes exceed 6,000 characters.`);return r;});
}
export function flag(s:string):boolean|null{const n=s.trim().toLowerCase();return ['true','yes','1'].includes(n)?true:['false','no','0'].includes(n)?false:null;}
export function dateValue(s:string):number|null{if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;const v=Date.parse(s+'T00:00:00Z');return Number.isFinite(v)&&new Date(v).toISOString().slice(0,10)===s?v:null;}
export function deduplicate(rows:RawLead[]):Lead[]{const groups=new Map<string,RawLead[]>();rows.forEach((r,i)=>{const key=r.email.trim().toLowerCase()||`missing-${i}`;groups.set(key,[...(groups.get(key)||[]),r]);});return [...groups.values()].map((sources,i)=>{const latest=[...sources].sort((a,b)=>(dateValue(b.last_contact)||0)-(dateValue(a.last_contact)||0))[0];return {...latest,email:latest.email.trim().toLowerCase(),id:`lead-${i+1}`,sources,state:'queued',reason:'Waiting for the team',summary:'',subject:'',draft:'',evidence:[],review:'pending',processed:false};});}
export function qualify(lead:Lead,date:string):Pick<Lead,'state'|'reason'>{
 const s=lead.sources,today=dateValue(date)!;const decide=(state:Lead['state'],reason:string)=>({state,reason});
 if(s.some(r=>flag(r.opted_out)===true))return decide('excluded','Opted out — no outreach');
 if(s.some(r=>flag(r.active_customer)===true||/^(customer|active customer|closed won)$/i.test(r.stage)))return decide('excluded','Active customer — use the existing relationship');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email))return decide('hold','Missing or invalid email address');
 if(s.some(r=>flag(r.opted_out)===null||flag(r.active_customer)===null))return decide('hold','Contact preferences or customer status need verification');
 if(new Set(s.map(r=>r.name.toLowerCase())).size>1||new Set(s.map(r=>r.company.toLowerCase()).filter(Boolean)).size>1)return decide('hold','Conflicting identities share this email');
 if(s.some(r=>!dateValue(r.last_contact)||(r.next_followup&&!dateValue(r.next_followup))))return decide('hold','Missing or invalid dates — use YYYY-MM-DD');
 if(s.some(r=>dateValue(r.last_contact)!>today))return decide('hold','Last-contact date is in the future');
 if(s.some(r=>r.next_followup&&dateValue(r.next_followup)!>today))return decide('hold','Requested follow-up is not due yet');
 const days=Math.floor((today-dateValue(lead.last_contact)!)/86400000);
 if(days<30)return decide('hold','Contacted within the last 30 days');
 if(s.some(r=>/not relevant|not interested|no fit|do not contact|no further outreach/i.test(r.notes)))return decide('hold','No supported reason to reopen this conversation');
 if(days>365)return decide('hold','History is over a year old — verify it first');
 if(!s.some(r=>r.notes.trim().length>=30)||!s.some(r=>r.next_followup))return decide('hold','Needs a documented follow-up date and useful context');
 return decide('ready','Requested follow-up is due; ready for human review');
}
export function summarize(lead:Lead){return lead.sources.filter(s=>s.notes).map(s=>s.notes).join('\n\n');}
export function draftTemplate(lead:Lead,offer:string){const name=lead.name.split(' ')[0];return {subject:`Picking up our conversation${lead.company?` — ${lead.company}`:''}`,draft:`Hi ${name},\n\nI'm following up on our earlier conversation. Is this still something you would like to explore?\n\n${offer.trim()}\n\nWould a short conversation be useful?`,evidence:lead.sources.filter(s=>s.notes).map(s=>`Row ${s.row}: ${s.notes}`)};}
export function exportCSV(leads:Lead[]):string{
 /* A cell that begins with = + @ or - is a formula-injection vector in Excel and Sheets,
    and the trigger can be hidden behind leading whitespace or control characters — which
    is exactly why the character class includes them. Narrowing it to satisfy the linter
    would weaken a security control, so the rule is suppressed and the reason stated. */
 const quote=(value:string|number|null|undefined)=>{let s=String(value??'');
  // eslint-disable-next-line no-control-regex
  if(/^[\s\u0000-\u001f]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};const fields=['name','company','email','state','reason','review','subject','draft','summary','source_rows'];return '\uFEFF'+[fields,...leads.map(l=>[l.name,l.company,l.email,l.state,l.reason,l.review,l.subject,l.draft,l.summary,l.sources.map(s=>s.row).join(';')])].map(r=>r.map(quote).join(',')).join('\r\n');}
export function makeReport(leads:Lead[],mode:string,date:string){return {product:'O6 Office',mode,evaluated_at:date,created_at:new Date().toISOString(),sent_messages:0,leads};}
