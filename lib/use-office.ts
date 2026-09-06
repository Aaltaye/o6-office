'use client';
import {useEffect,useRef,useState} from 'react';
import {SAMPLE_CSV,SAMPLE_DATE,DEFAULT_OFFER,parseCSV,deduplicate,qualify,summarize,draftTemplate,type Lead,type Department,type WorkEvent} from './lead-engine';
const wait=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{if(signal.aborted){reject(new DOMException('Stopped','AbortError'));return;}const finish=()=>{signal.removeEventListener('abort',abort);resolve();};const timer=setTimeout(finish,ms);const abort=()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'));};signal.addEventListener('abort',abort,{once:true});});
type Output={summary?:string;subject?:string;draft?:string;evidence?:{row:number;quote:string}[];approved?:boolean;review_note?:string};
export function useOffice(){
 const [rows,setRows]=useState(()=>parseCSV(SAMPLE_CSV)),[leads,setLeads]=useState<Lead[]>(()=>deduplicate(parseCSV(SAMPLE_CSV)));
 const [sample,setSample]=useState(true),[sourceName,setSourceName]=useState('Fictional sample');
 const [events,setEvents]=useState<WorkEvent[]>([]),[active,setActive]=useState<Record<string,Department>>({});
 const [phase,setPhase]=useState<'idle'|'running'|'completed'|'stopped'>('idle'),[error,setError]=useState('');
 const [apiKey,setApiKey]=useState(''),[offer,setOffer]=useState(DEFAULT_OFFER),[runMode,setRunMode]=useState('Sample · local rules');
 const [elapsed,setElapsed]=useState(0),[speed,setSpeed]=useState(1),[usage,setUsage]=useState({tokens:0,cost:0,calls:0});
 const controller=useRef<AbortController|null>(null),busy=useRef(false),clock=useRef(0),speedRef=useRef(1),index=useRef(0);
 const running=phase==='running',date=sample?SAMPLE_DATE:new Date().toISOString().slice(0,10);
 useEffect(()=>{if(!running)return;const id=setInterval(()=>setElapsed(Math.floor((Date.now()-clock.current)/1000)),500);return()=>clearInterval(id);},[running]);
 useEffect(()=>()=>controller.current?.abort(),[]);
 const updateLead=(id:string,patch:Partial<Lead>)=>setLeads(prev=>prev.map(l=>l.id===id?{...l,...patch}:l));
 const log=(department:Department,title:string,detail:string,kind:WorkEvent['kind']='completed',leadId?:string,tokens?:number)=>setEvents(prev=>[...prev,{id:`event-${++index.current}`,at:new Date().toISOString(),department,title,detail,kind,leadId,tokens}]);
 function importCSV(text:string,name:string){if(busy.current)throw new Error('Stop the current run before importing.');const data=parseCSV(text);setRows(data);setLeads(deduplicate(data));setSample(false);setSourceName(name);setOffer('');setPhase('idle');setEvents([]);setActive({});setUsage({tokens:0,cost:0,calls:0});setElapsed(0);setError('');}
 function resetSample(){if(busy.current)return;setRows(parseCSV(SAMPLE_CSV));setLeads(deduplicate(parseCSV(SAMPLE_CSV)));setSample(true);setOffer(DEFAULT_OFFER);setSourceName('Fictional sample');setPhase('idle');setEvents([]);setElapsed(0);setUsage({tokens:0,cost:0,calls:0});setRunMode('Sample · local rules');setError('');}
 async function run(forceSample=false){
  if(busy.current)throw new Error('A run is already in progress.');
  const input=forceSample?parseCSV(SAMPLE_CSV):rows,isSample=forceSample||sample,key=forceSample?'':apiKey.trim(),runOffer=forceSample?DEFAULT_OFFER:offer.trim();
  if(!runOffer){setError('Add a short description of your offer in run settings.');return {error:'Offer required'};}
  if(key&&!/^sk-[\w-]{10,}$/.test(key)){setError('Check the API key in run settings.');return {error:'Invalid key'};}
  busy.current=true;const abort=new AbortController();controller.current=abort;const signal=abort.signal;
  if(forceSample){setRows(input);setSample(true);setSourceName('Fictional sample');setOffer(DEFAULT_OFFER);}
  const batch=deduplicate(input),runDate=isSample?SAMPLE_DATE:new Date().toISOString().slice(0,10);
  setLeads(batch);setEvents([]);index.current=0;setActive({});setError('');setUsage({tokens:0,cost:0,calls:0});setElapsed(0);clock.current=Date.now();setPhase('running');setRunMode(key?'Live AI · GPT-4.1 mini':isSample?'Sample · local rules':'Your data · local rules');
  log('Records',`${input.length} records received`,`${batch.length} unique leads. ${input.length-batch.length} duplicate records merged by email. ${key?'AI specialists are enabled.':'Local rules and templates; no model calls.'}`);
  const move=async(l:Lead,d:Department,title:string)=>{if(signal.aborted)throw new DOMException('Stopped','AbortError');setActive(prev=>({...prev,[l.id]:d}));log(d,title,l.company||l.name,'started',l.id);await wait((key?200:700)/speedRef.current,signal);};
  const agent=async(task:'context'|'draft'|'review',l:Lead):Promise<Output>=>{
   const response=await fetch('/api/agent',{method:'POST',signal,headers:{'Content-Type':'application/json','x-o6-api-key':key},body:JSON.stringify({task,lead:l,offer:runOffer,date:runDate})});
   const body=await response.json() as {error?:string;output:Output;usage:{input:number;output:number;estimatedCost:number}};if(!response.ok)throw new Error(body.error||'The assignment failed.');
   setUsage(v=>({tokens:v.tokens+body.usage.input+body.usage.output,cost:v.cost+body.usage.estimatedCost,calls:v.calls+1}));
   log(task==='context'?'Context':task==='draft'?'Outreach':'Review',`${task==='draft'?'Draft':task==='context'?'Context':'Review'} artifact received`,'GPT-4.1 mini completed this assignment.','completed',l.id,body.usage.input+body.usage.output);
   return body.output;
  };
  const processLead=async(original:Lead)=>{
   const l={...original};
   try{
    await move(l,'Records','Checking the record');Object.assign(l,qualify(l,runDate));
    log('Records','Record checked',l.sources.length>1?`${l.sources.length} source rows joined; all contact preferences preserved.`:'Email, dates, and contact preferences checked.','completed',l.id);
    if(l.state==='excluded'){l.processed=true;updateLead(l.id,l);log('Records','Removed from outreach',l.reason,'warning',l.id);return;}
    await move(l,'Context','Reading the conversation history');l.summary=summarize(l)||'No history was supplied.';
    if(key&&l.state==='ready'){const result=await agent('context',l);l.summary=result.summary||l.summary;l.evidence=(result.evidence||[]).map(e=>`Row ${e.row}: ${e.quote}`);}
    updateLead(l.id,{summary:l.summary});log('Context','History assembled',`${l.sources.length} source record${l.sources.length>1?'s':''} attached to this lead.`,'completed',l.id);
    await move(l,'Research','Checking the source trail');if(!l.evidence.length)l.evidence=l.sources.filter(s=>s.notes).map(s=>`Row ${s.row}: ${s.notes}`);
    log('Research','Source trail attached',`${l.evidence.length} references to supplied notes. No external web research was performed.`,'completed',l.id);
    await move(l,'Opportunity','Checking the follow-up window');log('Opportunity',l.state==='ready'?'A conversation worth reviewing':'Follow-up held',l.reason,l.state==='ready'?'completed':'warning',l.id);
    if(l.state!=='ready'){l.processed=true;updateLead(l.id,l);return;}
    await move(l,'Outreach',key?'Assigning a draft specialist':'Preparing a template draft');
    if(key){const result=await agent('draft',l);l.subject=result.subject||'';l.draft=result.draft||'';l.evidence=(result.evidence||[]).map(e=>`Row ${e.row}: ${e.quote}`);}else Object.assign(l,draftTemplate(l,runOffer));
    updateLead(l.id,{subject:l.subject,draft:l.draft,evidence:l.evidence});log('Outreach','Draft prepared',key?'Personalized from supplied records and your offer.':'A local template is ready. Personalize it before approving.','completed',l.id);
    await move(l,'Review',key?'Assigning an independent reviewer':'Checking the review packet');
    if(key){const result=await agent('review',l);if(!result.approved){l.state='hold';l.review='held';l.reason=result.review_note||'The AI reviewer requested changes.';}log('Review',result.approved?'Handed to you for review':'Revision required',result.review_note||'Review completed.',result.approved?'completed':'warning',l.id);}else log('Review','Ready for your review','Eligibility rules passed. The template and notes are attached; no AI review was performed.','completed',l.id);
    l.processed=true;updateLead(l.id,l);
   }catch(err){if(signal.aborted)return;const message=err instanceof Error?err.message:'The assignment failed.';updateLead(l.id,{state:'hold',reason:'AI assignment failed — review required',aiError:message,processed:true,review:'held'});log('Review','Assignment needs attention',message,'warning',l.id);}
   finally{setActive(prev=>{const next={...prev};delete next[l.id];return next;});}
  };
  let cursor=0;const worker=async()=>{while(cursor<batch.length&&!signal.aborted){const lead=batch[cursor++];await processLead(lead);}};
  try{await Promise.all([worker(),worker()]);setPhase(signal.aborted?'stopped':'completed');log('Review',signal.aborted?'Run stopped':'The office has finished',signal.aborted?'Completed artifacts remain available. Rerun to start a fresh pass.':'Review your leads and export the packet. No messages were sent.',signal.aborted?'warning':'completed');}
  finally{busy.current=false;setActive({});setElapsed(Math.floor((Date.now()-clock.current)/1000));controller.current=null;}
  return {status:signal.aborted?'stopped':'completed',uniqueLeads:batch.length};
 }
 return {rows,leads,sample,sourceName,events,active,phase,error,setError,apiKey,setApiKey,offer,setOffer,runMode,elapsed,speed,usage,running,date,run,importCSV,resetSample,updateLead,log,stop:()=>controller.current?.abort(),toggleSpeed:()=>{const next=speed===1?3:1;setSpeed(next);speedRef.current=next;}};
}
