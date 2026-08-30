const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore } = require('firebase-admin/firestore');
const { TOOL_CATALOG, executeTool } = require('./agent-tools-v20');

const groqApiKey = defineSecret('GROQ_API_KEY');
const githubToken = defineSecret('NEXUS_GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const AUTHORIZED_EMAIL = 'giva.norberto@gmail.com';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_PROMPT_CHARS = 4000;
const MAX_TOOLS = 4;
const TZ = 'America/Sao_Paulo';

const MONTHS = {
  janeiro:1, fevereiro:2, marco:3, abril:4, maio:5, junho:6,
  julho:7, agosto:8, setembro:9, outubro:10, novembro:11, dezembro:12
};
const NUMBERS = {um:1,uma:1,dois:2,duas:2,tres:3,quatro:4,cinco:5,seis:6,sete:7,oito:8,nove:9,dez:10};

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function assertAuthorized(request) {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!request.auth || email !== AUTHORIZED_EMAIL) throw new HttpsError('permission-denied', 'Usuário não autorizado.');
}

function providerFailure(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return /resource-exhausted|unavailable|internal|429|cota|limite|capacity/.test(text);
}

async function groq(system, prompt, maxTokens = 1200) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{Authorization:`Bearer ${groqApiKey.value()}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      model:GROQ_MODEL,
      messages:[{role:'system',content:system},{role:'user',content:prompt}],
      temperature:0.05,
      max_completion_tokens:maxTokens,
      stream:false
    })
  });
  if (!response.ok) {
    const error = new Error(`Groq HTTP ${response.status}`);
    error.code = response.status === 429 ? 'resource-exhausted' : 'internal';
    throw error;
  }
  const payload = await response.json();
  const text = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Groq retornou resposta vazia.');
  return {text, provider:'groq'};
}

async function gemini(system, prompt, maxTokens = 1200) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey.value())}`,
    {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        systemInstruction:{parts:[{text:system}]},
        contents:[{role:'user',parts:[{text:prompt}]}],
        generationConfig:{temperature:0.05,maxOutputTokens:maxTokens}
      })
    }
  );
  if (!response.ok) {
    const error = new Error(`Gemini HTTP ${response.status}`);
    error.code = response.status === 429 ? 'resource-exhausted' : 'internal';
    throw error;
  }
  const payload = await response.json();
  const text = (payload?.candidates?.[0]?.content?.parts || []).map((p)=>String(p?.text||'')).join('\n').trim();
  if (!text) throw new Error('Gemini retornou resposta vazia.');
  return {text, provider:'gemini'};
}

async function freeSynthesis(system, prompt) {
  try { return await groq(system, prompt); }
  catch (error) {
    if (!providerFailure(error)) throw error;
    try { return await gemini(system, prompt); }
    catch (fallback) {
      if (providerFailure(fallback)) return null;
      throw fallback;
    }
  }
}

async function loadMaps() {
  try {
    const snap = await getFirestore().collection('source_maps').limit(50).get();
    return snap.docs.map((doc) => {
      const v = doc.data() || {};
      return {
        id:doc.id,
        project:String(v.project || doc.id),
        name:String(v.name || v.project || doc.id),
        aliases:Array.isArray(v.aliases) ? v.aliases.map(String) : [],
        sources:Array.isArray(v.sources) ? v.sources : []
      };
    });
  } catch (error) {
    console.error('Nexus v3 source_maps', error);
    return [];
  }
}

function mapTerms(map) {
  return [map.project,map.name,map.id,...(map.aliases||[])].map(normalize).filter(Boolean);
}

function resolveProject(prompt, maps, explicit='') {
  const requested = normalize(explicit);
  if (requested) {
    const found = maps.find((map)=>mapTerms(map).includes(requested));
    if (found) return found;
  }
  const text = normalize(prompt);
  const candidates = [];
  for (const map of maps) {
    for (const term of mapTerms(map)) {
      if (term.length >= 3 && text.includes(term)) {
        candidates.push({map,score:term.length});
        break;
      }
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  if (candidates[0]) return candidates[0].map;

  const legacy = [
    {project:'pronti-pet',name:'Pronti Pet',aliases:['pronti pet','pronti-pet'],legacy:true,repository:'giva-norberto/pronti-pet'},
    {project:'pronti-app',name:'Pronti',aliases:['pronti app','pronti-app','pronti'],legacy:true,repository:'giva-norberto/pronti-app'},
    {project:'nexus',name:'Nexus',aliases:['nexus'],legacy:true,repository:'giva-norberto/nexus'}
  ];
  for (const item of legacy) {
    if ([item.project,item.name,...item.aliases].map(normalize).some((term)=>text.includes(term))) {
      return {...item,sources:[{id:'codigo',domain:'codigo',tool:'github_investigate',repository:item.repository,readOnly:true}]};
    }
  }
  return null;
}

function nowParts(date=new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const get=(type)=>Number(parts.find((p)=>p.type===type)?.value||0);
  return {year:get('year'),month:get('month'),day:get('day')};
}

// Em 2026 São Paulo usa UTC-3. Intervalos são produzidos como calendário local, não "últimos 30 dias".
function localStartMs(year,month,day) { return Date.UTC(year,month-1,day,3,0,0,0); }
function monthRange(year,month,label) {
  const startMs=localStartMs(year,month,1);
  const next=new Date(Date.UTC(year,month,1));
  const endMs=localStartMs(next.getUTCFullYear(),next.getUTCMonth()+1,1)-1;
  return {kind:'month',label,startMs,endMs};
}
function dayRange(year,month,day,label) {
  const startMs=localStartMs(year,month,day);
  const next=new Date(Date.UTC(year,month-1,day+1));
  return {kind:'day',label,startMs,endMs:localStartMs(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate())-1};
}

function parsePeriod(prompt, now=new Date()) {
  const text=normalize(prompt);
  const current=nowParts(now);
  if (/\b(este|esse|neste|nesse) mes\b|\bmes atual\b/.test(text)) return monthRange(current.year,current.month,'este mês');
  if (/\bmes passado\b|\bultimo mes\b/.test(text)) {
    const d=new Date(Date.UTC(current.year,current.month-2,1));
    return monthRange(d.getUTCFullYear(),d.getUTCMonth()+1,'mês passado');
  }
  for (const [name,month] of Object.entries(MONTHS)) {
    const match=text.match(new RegExp(`\\b${name}(?:\\s+de\\s+(\\d{4}))?\\b`));
    if (match) {
      const year=Number(match[1]||current.year);
      return monthRange(year,month,`${name} de ${year}`);
    }
  }
  const days=text.match(/\bultim(?:os|as)\s+(\d{1,4})\s+dias?\b/);
  if (days) {
    const n=Math.max(1,Math.min(3650,Number(days[1])));
    return {kind:'days',label:`últimos ${n} dias`,startMs:now.getTime()-n*86400000,endMs:now.getTime(),days:n};
  }
  if (/\bhoje\b/.test(text)) return dayRange(current.year,current.month,current.day,'hoje');
  if (/\bontem\b/.test(text)) {
    const d=new Date(Date.UTC(current.year,current.month-1,current.day-1));
    return dayRange(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),'ontem');
  }
  return null;
}

function extractLimit(prompt) {
  const text=normalize(prompt);
  const numeric=text.match(/\b(?:top\s*)?(\d{1,2})\s+(?:produto|produtos|item|itens|coisa|coisas|usuario|usuarios)\b/);
  if (numeric) return Math.max(1,Math.min(20,Number(numeric[1])));
  for (const [word,n] of Object.entries(NUMBERS)) {
    if (new RegExp(`\\b${word}\\s+(?:produto|produtos|item|itens|coisa|coisas|usuario|usuarios)\\b`).test(text)) return n;
  }
  return null;
}

function parseIntent(prompt) {
  const text=normalize(prompt);
  const entities=new Set();
  const operations=new Set();
  const metrics=new Set();
  const limit=extractLimit(prompt);

  const userCountRequested=/\bquant(?:os|as)\s+(?:usuarios|pessoas|contas)\b|\bnumero de usuarios\b|\btotal de usuarios\b/.test(text);
  const purchaseCountRequested=/\bquant(?:os|as)\s+compras\b|\bnumero de compras\b|\bcompras analisadas\b/.test(text);
  const itemCountRequested=/\bquant(?:os|as)\s+(?:itens|produtos)\b|\bnumero de itens\b|\bitens analisados\b/.test(text);

  if (/\busuari|\bpessoa|\bconta|\blogin|\bacess|\bentrou\b|\binativ/.test(text)) entities.add('users');
  if (/\bproduto|\bitem|\bcoisa|\bmercadoria/.test(text)) entities.add('products');
  if (/\bcompra|\bgasto|\bgastei|\bdinheiro|\bvalor|\bpreco|\bcusto|\bmercado|\bestabelecimento/.test(text)) entities.add('spending');
  if (/\bstatus\b|\bfuncionando\b|\bconectad|\bonline\b|\bsaude\b|\bfirebase\b|\bfirestore\b/.test(text)) entities.add('status');
  if (/\bcodigo\b|\barquivo|\bimplement|\bgithub\b|\brepositorio|\bbug\b|\bfuncao\b|\barquitetura/.test(text)) entities.add('code');
  if (/\bmemoria\b|\blembra|\bpreferencia|\bdecisao anterior/.test(text)) entities.add('memory');

  if (/\bquanto\b.*\bgast|\btotal gasto\b|\btotal\b.*\bgast|\bsoma\b/.test(text)) {
    operations.add('sum'); metrics.add('totalSpent'); entities.add('spending');
  }
  if (userCountRequested||purchaseCountRequested||itemCountRequested) operations.add('count');
  if (/\bultimo acesso\b|\bultimo login\b|\bacesso mais recente\b|\blogin mais recente\b|\bquem (?:entrou|acessou) por ultimo\b|\bmais recente\b/.test(text)) operations.add('latest');
  if (/\bmais tempo sem acess|\blogin mais antigo\b|\bmais antigo\b/.test(text)) operations.add('oldest');
  if (/\btop\b|\bmais gastei\b|\bmais gasto\b|\bmais pesaram\b|\bmaior aumento\b|\bmenor preco\b/.test(text)) operations.add('ranking');
  if ((entities.has('spending')||entities.has('products')) && (limit || (/\bmais\b/.test(text) && /\bonde\b|\bquais\b|\bqual\b|\bproduto|\bitem|\bcompra|\bgast|\bdinheiro/.test(text)))) operations.add('ranking');
  if (entities.has('status')) operations.add('status');
  if (entities.has('code')) operations.add('investigate');

  if (entities.has('users')) {
    if (userCountRequested) metrics.add('userCount');
    if (operations.has('latest')||operations.has('oldest')) metrics.add('lastSignInTime');
  }
  if (entities.has('spending')||entities.has('products')) {
    if (purchaseCountRequested) metrics.add('purchaseCount');
    if (itemCountRequested) metrics.add('itemCount');
    if (operations.has('ranking')) {
      if (/aumento/.test(text)) metrics.add('priceChangePct');
      else if (/menor preco/.test(text)) metrics.add('minUnitPrice');
      else metrics.add('productSpend');
    }
  }

  return {
    entities:[...entities],
    operations:[...operations],
    metrics:[...metrics],
    limit,
    period:parsePeriod(prompt),
    reasoning:/\banalis(?:e|ar)\b|\brecomend|\bpor que\b|\bporque\b|\bexplique\b|\bo que voce acha\b|\bestrateg|\bconclua\b/.test(text)
  };
}

function toolScore(source,intent,prompt) {
  const tool=String(source?.tool||'');
  let score=0;
  if (intent.entities.includes('users')&&tool==='firebase_auth_users') score+=100;
  if ((intent.entities.includes('spending')||intent.entities.includes('products'))&&tool==='listalar_spending_analytics') score+=100;
  if (intent.entities.includes('status')&&tool==='firebase_project_status') score+=100;
  if (intent.entities.includes('code')&&tool==='github_investigate') score+=100;
  if (intent.entities.includes('memory')&&tool==='memory_search') score+=100;

  const hay=normalize([source?.id,source?.domain,source?.source,...(source?.topics||[])].join(' '));
  const tokens=normalize(prompt).split(/[^a-z0-9_-]+/).filter((x)=>x.length>=4);
  score+=tokens.filter((token)=>hay.includes(token)).length*2;
  return score+Math.min(5,Number(source?.priority||0)/100);
}

function selectSources(map,intent,prompt) {
  if (!map?.sources) return [];
  const ranked=map.sources
    .filter((s)=>s?.readOnly!==false)
    .filter((s)=>TOOL_CATALOG.some((tool)=>tool.name===s.tool))
    .map((s)=>({...s,score:toolScore(s,intent,prompt)}))
    .filter((s)=>s.score>=20)
    .sort((a,b)=>b.score-a.score);
  const selected=[];
  const seen=new Set();
  for (const source of ranked) {
    if (seen.has(source.tool)) continue;
    if (source.tool==='firestore_read' && /[{][A-Za-z0-9_-]+[}]/.test(JSON.stringify(source.args||{}))) continue;
    selected.push(source); seen.add(source.tool);
    if (selected.length>=MAX_TOOLS) break;
  }
  return selected;
}

function toolArgs(source,intent,prompt,map) {
  const args={...(source.args||{})};
  if (!args.project) args.project=map.project;
  if (source.tool==='listalar_spending_analytics' && intent.period) {
    args.startMs=intent.period.startMs; args.endMs=intent.period.endMs;
    if (intent.period.days) args.days=intent.period.days;
  }
  if (source.tool==='github_investigate') {
    args.query=prompt;
    if (source.repository) args.repository=source.repository;
  }
  if (source.tool==='memory_search') args.query=prompt;
  return args;
}

async function runTools(sources,intent,request,prompt,map) {
  const evidence=[];
  const toolsUsed=[];
  for (const source of sources) {
    try {
      const result=await executeTool(source.tool,toolArgs(source,intent,prompt,map),request,{prompt,githubToken:githubToken.value()});
      evidence.push(result);
      toolsUsed.push({name:source.tool,ok:result?.ok!==false,sourceId:source.id||null,domain:source.domain||null});
    } catch (error) {
      evidence.push({tool:source.tool,ok:false,error:String(error?.message||error)});
      toolsUsed.push({name:source.tool,ok:false,sourceId:source.id||null,domain:source.domain||null});
    }
  }
  return {evidence,toolsUsed};
}

function money(value) {
  return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value||0));
}
function date(value) {
  const d=new Date(value);
  return Number.isNaN(d.getTime())?String(value):new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'medium',timeZone:TZ}).format(d);
}
function periodText(intent) { return intent.period?.label ? ` em ${intent.period.label}` : ''; }

function analyticsAnswer(intent,result) {
  const lines=[];
  const suffix=periodText(intent);
  if (intent.metrics.includes('totalSpent')||intent.operations.includes('sum')) lines.push(`Total gasto${suffix}: ${money(result?.totalSpent)}.`);
  if (intent.metrics.includes('purchaseCount')) lines.push(`Compras${suffix}: ${result?.purchaseCount??0}.`);
  if (intent.metrics.includes('itemCount')) lines.push(`Itens${suffix}: ${result?.itemCount??0}.`);
  if (intent.operations.includes('ranking')&&intent.metrics.includes('productSpend')) {
    const items=(result?.topBySpend||[]).slice(0,intent.limit||5);
    lines.push(`Produtos com maior gasto${suffix}:`);
    items.forEach((item,i)=>lines.push(`${i+1}. ${item.name||item.key||'Produto'} — ${money(item.totalSpent)}.`));
  }
  if (intent.operations.includes('ranking')&&intent.metrics.includes('priceChangePct')) {
    const items=(result?.topPriceIncreases||[]).slice(0,intent.limit||5);
    lines.push(`Maiores aumentos de preço${suffix}:`);
    items.forEach((item,i)=>lines.push(`${i+1}. ${item.name||item.key||'Produto'} — ${Number(item.priceChangePct||0).toFixed(2)}%.`));
  }
  if (!lines.length) lines.push(`Total gasto observado${suffix}: ${money(result?.totalSpent)}. Compras: ${result?.purchaseCount??0}. Itens: ${result?.itemCount??0}.`);
  return lines.join('\n');
}

function authAnswer(intent,result) {
  const users=Array.isArray(result?.users)?result.users:[];
  const valid=users.filter((u)=>u.lastSignInTime&&Number.isFinite(Date.parse(u.lastSignInTime)));
  const lines=[];
  if (intent.metrics.includes('userCount')) lines.push(`Total de usuários: ${result?.returned??users.length}.`);
  if (intent.operations.includes('latest')&&valid[0]) lines.push(`Acesso mais recente: ${valid[0].displayName||valid[0].email} — ${date(valid[0].lastSignInTime)}.`);
  if (intent.operations.includes('oldest')&&valid.length) {
    const u=valid[valid.length-1];
    lines.push(`Há mais tempo sem novo login: ${u.displayName||u.email} — último login em ${date(u.lastSignInTime)}.`);
  }
  return lines.join('\n')||`Total de usuários: ${result?.returned??users.length}.`;
}

function deterministic(intent,evidence) {
  const sections=[];
  for (const item of evidence) {
    if (!item||item.ok===false) { sections.push(`${item?.tool||'Ferramenta'}: falha — ${item?.error||'sem detalhe'}.`); continue; }
    if (item.tool==='listalar_spending_analytics') sections.push(analyticsAnswer(intent,item));
    else if (item.tool==='firebase_auth_users') sections.push(authAnswer(intent,item));
    else if (item.tool==='firebase_project_status') {
      const a=item.authentication; const f=item.firestore;
      sections.push([
        a?`Authentication: ${a.totalUsers??0} usuário(s), ${a.enabledUsers??0} ativo(s), ${a.disabledUsers??0} desativado(s).`:'',
        f?`Firestore: ${f.rootCollectionCount??0} coleção(ões) raiz${f.rootCollections?.length?` (${f.rootCollections.join(', ')})`:''}.`:''
      ].filter(Boolean).join('\n'));
    } else if (item.tool==='github_investigate') {
      const files=(item.files||[]).filter((x)=>x?.path);
      sections.push(files.length?`GitHub ${item.repository||''}: arquivos mais relevantes:\n${files.map((x,i)=>`${i+1}. ${x.path}`).join('\n')}`:'Nenhum arquivo relevante encontrado.');
    } else if (item.tool==='memory_search') {
      const matches=(item.matches||[]).slice(0,8);
      sections.push(matches.length?matches.map((m,i)=>`${i+1}. ${m.text}`).join('\n'):'Não encontrei memória relevante.');
    }
  }
  return sections.join('\n\n')||'Não encontrei evidência suficiente para responder com segurança.';
}

async function synthesize(prompt,intent,evidence) {
  const system=[
    'Você é Nexus Agent Core v3.',
    'A intenção já foi estruturada e as ferramentas já foram executadas; não planeje novamente.',
    'Responda em português do Brasil, de forma direta.',
    'Use somente as evidências fornecidas para afirmar fatos.',
    'Não invente arquivos, dados, datas ou ações.',
    'Em código, use os snippets para indicar o arquivo mais provável/confirmado e diga quando a evidência não bastar.',
    'Modo somente leitura; nenhuma alternativa paga.'
  ].join(' ');
  return freeSynthesis(system,`Pergunta: ${prompt}\n\nIntenção: ${JSON.stringify(intent)}\n\nEvidências: ${JSON.stringify(evidence).slice(0,30000)}`);
}

exports.askNexusAgent=onCall(
  {region:'southamerica-east1',secrets:[groqApiKey,githubToken,geminiApiKey],maxInstances:1,timeoutSeconds:120,memory:'512MiB'},
  async (request)=>{
    assertAuthorized(request);
    const prompt=String(request.data?.prompt||'').trim();
    if (!prompt) throw new HttpsError('invalid-argument','Informe uma pergunta.');
    if (prompt.length>MAX_PROMPT_CHARS) throw new HttpsError('invalid-argument',`Pergunta limitada a ${MAX_PROMPT_CHARS} caracteres.`);

    const maps=await loadMaps();
    const map=resolveProject(prompt,maps,request.data?.project||'');
    const intent=parseIntent(prompt);
    if (!map) return {answer:'Não consegui identificar o projeto. Informe o projeto ou cadastre-o no Índice de Fontes.',agentCore:true,version:'3.0',intent,readOnly:true,freeOnlyPolicy:true};

    const sources=selectSources(map,intent,prompt);
    if (!sources.length) return {answer:`Identifiquei ${map.name}, mas o Índice de Fontes não tem uma capacidade compatível com esta pergunta.`,agentCore:true,version:'3.0',intent,sourceMapProject:map.project,readOnly:true,freeOnlyPolicy:true};

    const {evidence,toolsUsed}=await runTools(sources,intent,request,prompt,map);
    let answer=deterministic(intent,evidence);
    let provider='native';
    let aiCalls=0;

    if (intent.reasoning||intent.entities.includes('code')) {
      const result=await synthesize(prompt,intent,evidence);
      if (result?.text) { answer=result.text; provider=result.provider; aiCalls=1; }
    }

    return {
      answer,
      agentCore:true,
      version:'3.0',
      architecture:'intent-capability-tool',
      sourceMapProject:map.project,
      sourceMapLoaded:!map.legacy,
      intent,
      matchedSources:sources.map((s)=>({id:s.id||null,domain:s.domain||null,tool:s.tool,score:Math.round(s.score*100)/100})),
      toolsUsed,
      evidenceCount:evidence.length,
      provider,
      aiCalls,
      zeroAiRoute:aiCalls===0,
      readOnly:true,
      freeOnlyPolicy:true
    };
  }
);
