import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {deduplicate,parseCSV,SAMPLE_CSV,SAMPLE_DATE,DEFAULT_OFFER} from '../lib/lead-engine.ts';
// The route is compiled and imported as a data: URL, which has no base to resolve
// relative imports against — so every specifier it uses is rewritten to an absolute
// file URL first.
const engine=new URL('../lib/lead-engine.ts',import.meta.url).href;
const compile=(url,rewrites)=>{
 let source=fs.readFileSync(new URL(url,import.meta.url),'utf8');
 for(const [from,to] of rewrites) source=source.replace(from,to);
 const out=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 return 'data:text/javascript;base64,'+Buffer.from(out).toString('base64');
};
// providers.ts imports only its own types, so it needs no rewrites.
const providersUrl=compile('../app/api/agent/providers.ts',[]);
const {POST}=await import(compile('../app/api/agent/route.ts',[['@/lib/lead-engine',engine],["'./providers'",`'${providersUrl}'`]]));
const lead=deduplicate(parseCSV(SAMPLE_CSV))[0];
const payload={task:'context',lead,offer:DEFAULT_OFFER,date:SAMPLE_DATE};
const request=(body=payload,headers={})=>new Request('http://localhost/api/agent',{method:'POST',headers:{'Content-Type':'application/json','x-o6-api-key':'sk-fake-for-unit-test-only',...headers},body:JSON.stringify(body)});
test('API rejects absent keys without calling model',async()=>{const res=await POST(request(payload,{'x-o6-api-key':''}));assert.equal(res.status,401);});
test('API blocks cross-origin calls',async()=>{const res=await POST(request(payload,{origin:'https://other.example'}));assert.equal(res.status,403);});
test('API prevents excluded lead from entering model workflow',async()=>{const blocked=structuredClone(lead);blocked.sources[0].opted_out='true';assert.equal((await POST(request({...payload,lead:blocked}))).status,400);});
test('API validates request fields',async()=>{assert.equal((await POST(request({...payload,task:'send_email'}))).status,400);assert.equal((await POST(request({...payload,lead:{}}))).status,400);});
test('AI response references are validated and usage is reported',async()=>{const original=globalThis.fetch;try{globalThis.fetch=async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');const sent=JSON.parse(init.body);assert.equal(sent.store,false);assert.equal(sent.model,'gpt-4.1-mini');return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({summary:'Asked to reconnect.',evidence:[{row:lead.sources[0].row,quote:'Wanted to reduce manual inquiry routing.'}]})}]}],usage:{input_tokens:100,output_tokens:50,input_tokens_details:{cached_tokens:0}}});};const res=await POST(request());assert.equal(res.status,200);const body=await res.json();assert.equal(body.usage.input,100);assert.equal(body.usage.output,50);assert.equal(body.output.summary,'Asked to reconnect.');}finally{globalThis.fetch=original;}});
test('invented evidence fails visibly, with no fallback draft',async()=>{const original=globalThis.fetch;try{globalThis.fetch=async()=>Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({summary:'Invented',evidence:[{row:2,quote:'Raised ten million dollars.'}]})}]}]});const res=await POST(request());assert.equal(res.status,502);assert.match((await res.json()).error,/could not be matched/);}finally{globalThis.fetch=original;}});

// --- Anthropic, through the same validation path ---------------------------------
// The point of these is not that a second vendor works. It is that the guarantees are
// identical: the same schema, the same exact-source-quote check, the same refusal to
// substitute a draft when something goes wrong.

const anthropicKey = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const anthropicRequest = (body = payload) => request(body, { 'x-o6-api-key': anthropicKey });

test('the provider is inferred from the key, with no extra configuration', async () => {
  const original = globalThis.fetch;
  try {
    let calledUrl = null;
    globalThis.fetch = async (url, init) => {
      calledUrl = String(url);
      const sent = JSON.parse(init.body);
      // Structured outputs, so the schema guarantee is the same one the OpenAI path has.
      assert.ok(sent.output_config?.format?.schema, 'must constrain the response schema');
      assert.equal(init.headers['anthropic-version'], '2023-06-01');
      assert.equal(init.headers['x-api-key'], anthropicKey);
      return Response.json({
        content: [{ type: 'text', text: JSON.stringify({ summary: 'Asked to reconnect.', evidence: [] }) }],
        usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 10 },
      });
    };
    const res = await POST(anthropicRequest());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(calledUrl, 'https://api.anthropic.com/v1/messages');
    assert.equal(body.provider, 'anthropic');
    assert.equal(body.model, 'claude-opus-5');
    // Cache reads count toward input, and are reported separately so the meter can be
    // honest about what was actually charged at the full rate.
    assert.equal(body.usage.input, 210);
    assert.equal(body.usage.cached, 10);
    assert.ok(body.usage.estimatedCost > 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('invented evidence is rejected on the Anthropic path too', async () => {
  // The check that matters most, proven for the second provider rather than assumed.
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: 'Invented',
              evidence: [{ row: 2, quote: 'Raised ten million dollars.' }],
            }),
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const res = await POST(anthropicRequest());
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /could not be matched/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a refusal is reported as a refusal, not as unreadable output', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({ stop_reason: 'refusal', content: [], usage: { input_tokens: 5, output_tokens: 0 } });
    const res = await POST(anthropicRequest());
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /declined this assignment/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a malformed Anthropic key is refused before any call is made', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error('no request should have been made');
    };
    const res = await POST(request(payload, { 'x-o6-api-key': 'sk-ant-short' }));
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /OpenAI or Anthropic/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a rejected key is reported as a key problem, naming the vendor', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    const res = await POST(anthropicRequest());
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /Anthropic API key was rejected/);
  } finally {
    globalThis.fetch = original;
  }
});
