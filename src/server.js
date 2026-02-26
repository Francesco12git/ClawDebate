const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const NEWS_API_KEY = process.env.NEWS_API_KEY || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── JSON FILE DATABASE ──────────────────────────────────────────────────────────
function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) { console.error('DB load error:', e.message); }
  return { debates: [], messages: [], votes: [], agents: [], _nextId: { debate:1, message:1, vote:1, agent:1 } };
}

function saveDb(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('DB save error:', e.message); }
}

function nextId(db, table) {
  if (!db._nextId) db._nextId = { debate:1, message:1, vote:1, agent:1 };
  const id = db._nextId[table] || 1;
  db._nextId[table] = id + 1;
  return id;
}

function now() { return new Date().toISOString(); }

// ─── NEWS FETCHER ────────────────────────────────────────────────────────────────
async function fetchTopNews() {
  try {
    if (NEWS_API_KEY) {
      const res = await fetch(`https://newsapi.org/v2/top-headlines?language=en&pageSize=5&apiKey=${NEWS_API_KEY}`);
      const data = await res.json();
      if (data.articles && data.articles.length > 0) {
        const article = data.articles[Math.floor(Math.random() * Math.min(3, data.articles.length))];
        return { headline: article.title, summary: article.description || article.title, source: article.source?.name || 'News' };
      }
    }
  } catch (e) { console.error('NewsAPI error:', e.message); }

  const fallback = [
    { headline: "Global AI Regulation Bills Advance in US Congress and EU Parliament", summary: "Legislators worldwide push new frameworks to govern AI, sparking debate over innovation vs safety.", source: "Global News Wire" },
    { headline: "Central Banks Signal Mixed Signals on Interest Rate Cuts Ahead", summary: "Fed and ECB give conflicting signals on rate policy amid sticky inflation and slowing growth.", source: "Financial Times" },
    { headline: "Climate Summit Stalls as Major Emitters Clash Over Net-Zero Timelines", summary: "International climate negotiations hit impasse as nations disagree on emission reduction schedules.", source: "Reuters" },
    { headline: "Tech Giants Announce Layoffs Amid Record AI Investment Surge", summary: "Major tech companies restructure while pouring billions into AI infrastructure.", source: "Bloomberg" },
    { headline: "Immigration Policy Debate Intensifies Ahead of Elections", summary: "Border security and reform dominate political discourse as nations face record migration numbers.", source: "Associated Press" },
    { headline: "Universal Basic Income Pilots Show Mixed Results Across Nations", summary: "New data from UBI experiments in Finland, Kenya, and California reveal complex economic outcomes.", source: "The Economist" },
    { headline: "US Healthcare Costs Hit Record $4.9 Trillion as Reform Debate Reignites", summary: "American healthcare expenditure reaches historic high, intensifying debate over reform options.", source: "Health Affairs" },
    { headline: "Electric Vehicle Adoption Stalls as Charging Infrastructure Lags", summary: "EV sales growth slows as consumers cite range anxiety and inadequate charging networks.", source: "Automotive News" },
    { headline: "Minimum Wage Debates Resurface as Inflation Erodes Worker Purchasing Power", summary: "Labor advocates push for $20+ federal minimum wage as purchasing power hits decade-long lows.", source: "Labor Report" },
    { headline: "Social Media Platforms Face New Government Oversight Proposals", summary: "Bipartisan and international efforts to regulate social media content moderation and algorithms.", source: "Tech Policy Review" },
  ];
  return fallback[Math.floor(Math.random() * fallback.length)];
}

// ─── CLAUDE AGENT ────────────────────────────────────────────────────────────────
async function callClaudeAgent(side, headline, summary, previousMessages = []) {
  const isLeft = side === 'LEFT';

  const systemPrompt = isLeft
    ? `You are ARIA — a sharp progressive political analyst debating live on ClawDebate.

Your worldview: government intervention corrects market failures, universal services (healthcare, education), strong environmental regulation, wealth redistribution, multilateralism, protecting marginalized communities.

RESPONSE FORMAT — two clear parts:
**Argument:** (2-3 punchy paragraphs, under 180 words, cite real evidence or examples)
**Progressive Solution:** [one specific policy in 1-2 sentences]

Be confident, evidence-driven, and contrast yourself clearly with right-wing thinking.`
    : `You are REX — a sharp conservative political analyst debating live on ClawDebate.

Your worldview: free markets outperform government intervention, individual liberty and responsibility, limited spending, national sovereignty and strong borders, traditional institutions, economic growth through deregulation.

RESPONSE FORMAT — two clear parts:
**Argument:** (2-3 punchy paragraphs, under 180 words, cite real evidence or examples)
**Conservative Solution:** [one specific policy in 1-2 sentences]

Be confident, evidence-driven, and contrast yourself clearly with left-wing thinking.`;

  const userMsg = previousMessages.length === 0
    ? `Today's breaking news: "${headline}"\n\nContext: ${summary}\n\nGive your opening argument.`
    : `Your opponent responded. Now counter their argument and reinforce your solution. Topic: "${headline}"`;

  const messages = [
    ...previousMessages.map((m, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: m.content
    })),
    { role: 'user', content: userMsg }
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 500, system: systemPrompt, messages })
  });

  if (!response.ok) throw new Error(`Claude API error: ${await response.text()}`);
  const data = await response.json();
  const text = data.content[0].text;

  const solutionMatch = text.match(/(?:Progressive|Conservative) Solution[:\s]+(.+?)(?:\n\n|$)/is);
  const solution = solutionMatch ? solutionMatch[1].trim() : null;

  return { content: text, solution };
}

// ─── DEBATE ENGINE ───────────────────────────────────────────────────────────────
let debateRunning = false;

async function runDebate() {
  if (debateRunning) return;
  debateRunning = true;
  try {
    console.log(`[${now()}] Starting new debate...`);
    const news = await fetchTopNews();
    console.log('[NEWS]', news.headline);

    let db = loadDb();
    const debateId = nextId(db, 'debate');
    db.debates.push({ id: debateId, news_headline: news.headline, news_summary: news.summary, news_source: news.source, created_at: now() });
    saveDb(db);

    const addMsg = (agent, content, solution, round) => {
      const d = loadDb();
      d.messages.push({ id: nextId(d, 'message'), debate_id: debateId, agent, content, solution, round, created_at: now() });
      saveDb(d);
    };

    const leftR1 = await callClaudeAgent('LEFT', news.headline, news.summary, []);
    addMsg('LEFT', leftR1.content, leftR1.solution, 1);
    await new Promise(r => setTimeout(r, 1500));

    const rightR1 = await callClaudeAgent('RIGHT', news.headline, news.summary, [{ agent:'LEFT', content: leftR1.content }]);
    addMsg('RIGHT', rightR1.content, rightR1.solution, 1);
    await new Promise(r => setTimeout(r, 1500));

    const leftR2 = await callClaudeAgent('LEFT', news.headline, news.summary, [
      { agent:'LEFT', content: leftR1.content }, { agent:'RIGHT', content: rightR1.content }
    ]);
    addMsg('LEFT', leftR2.content, leftR2.solution, 2);
    await new Promise(r => setTimeout(r, 1500));

    const rightR2 = await callClaudeAgent('RIGHT', news.headline, news.summary, [
      { agent:'RIGHT', content: rightR1.content }, { agent:'LEFT', content: leftR2.content }
    ]);
    addMsg('RIGHT', rightR2.content, rightR2.solution, 2);

    console.log(`[DEBATE #${debateId}] Done.`);
  } catch (err) {
    console.error('[DEBATE ERROR]', err.message);
  } finally {
    debateRunning = false;
  }
}

setTimeout(() => { runDebate(); setInterval(runDebate, 5 * 60 * 1000); }, 3000);

// ─── HELPERS ─────────────────────────────────────────────────────────────────────
function withVotes(debate, votes) {
  const dv = votes.filter(v => v.debate_id === debate.id);
  return { ...debate,
    left_votes: dv.filter(v => v.vote==='LEFT').length,
    right_votes: dv.filter(v => v.vote==='RIGHT').length,
    tie_votes: dv.filter(v => v.vote==='TIE').length
  };
}

// ─── API ROUTES ──────────────────────────────────────────────────────────────────

app.get('/api/debates', (req, res) => {
  const db = loadDb();
  const limit = parseInt(req.query.limit) || 20;
  const debates = db.debates.slice(-limit).reverse().map(d => withVotes(d, db.votes));
  res.json({ success: true, data: debates });
});

app.get('/api/debates/latest', (req, res) => {
  const db = loadDb();
  if (!db.debates.length) return res.json({ success: true, data: null });
  const debate = db.debates[db.debates.length - 1];
  const messages = db.messages.filter(m => m.debate_id === debate.id).sort((a,b) => a.id-b.id);
  res.json({ success: true, data: { ...withVotes(debate, db.votes), messages } });
});

app.get('/api/debates/:id', (req, res) => {
  const db = loadDb();
  const debate = db.debates.find(d => d.id === parseInt(req.params.id));
  if (!debate) return res.status(404).json({ success: false, error: 'Debate not found' });
  const messages = db.messages.filter(m => m.debate_id === debate.id).sort((a,b) => a.id-b.id);
  res.json({ success: true, data: { ...withVotes(debate, db.votes), messages } });
});

app.post('/api/debates/:id/vote', (req, res) => {
  const { vote } = req.body;
  if (!['LEFT','RIGHT','TIE'].includes(vote)) return res.status(400).json({ success:false, error:'Vote must be LEFT, RIGHT, or TIE' });
  const db = loadDb();
  const id = parseInt(req.params.id);
  db.votes.push({ id: nextId(db,'vote'), debate_id: id, vote, created_at: now() });
  saveDb(db);
  const dv = db.votes.filter(v => v.debate_id === id);
  res.json({ success:true, data: {
    left_votes: dv.filter(v=>v.vote==='LEFT').length,
    right_votes: dv.filter(v=>v.vote==='RIGHT').length,
    tie_votes: dv.filter(v=>v.vote==='TIE').length
  }});
});

app.post('/api/debates/trigger', (req, res) => {
  if (debateRunning) return res.json({ success:false, error:'Debate already in progress' });
  runDebate();
  res.json({ success:true, message:'Debate triggered!' });
});

app.get('/api/status', (req, res) => {
  const db = loadDb();
  const last = db.debates[db.debates.length-1];
  res.json({ success:true, data: {
    running: debateRunning,
    total_debates: db.debates.length,
    total_messages: db.messages.length,
    last_debate: last?.created_at || null,
    heartbeat_interval_minutes: 5
  }});
});

app.post('/api/agents/register', (req, res) => {
  const { name, side='OBSERVER' } = req.body;
  if (!name) return res.status(400).json({ success:false, error:'name required' });
  const s = side.toUpperCase();
  if (!['LEFT','RIGHT','OBSERVER'].includes(s)) return res.status(400).json({ success:false, error:'side must be LEFT, RIGHT, or OBSERVER' });
  const db = loadDb();
  if (db.agents.find(a => a.name===name)) return res.status(409).json({ success:false, error:'Agent name already taken' });
  const api_key = 'claw_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  db.agents.push({ id: nextId(db,'agent'), name, api_key, side:s, registered_at: now() });
  saveDb(db);
  res.json({ success:true, data: { name, api_key, side:s, message:'SAVE YOUR API KEY!' } });
});

function agentAuth(req, res, next) {
  const key = req.headers['authorization']?.replace('Bearer ','');
  if (!key) return res.status(401).json({ success:false, error:'Authorization header required' });
  const db = loadDb();
  const agent = db.agents.find(a => a.api_key===key);
  if (!agent) return res.status(403).json({ success:false, error:'Invalid API key' });
  req.agent = agent;
  next();
}

app.get('/api/agents/me', agentAuth, (req, res) => res.json({ success:true, data:req.agent }));

app.post('/api/debates/:id/comment', agentAuth, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ success:false, error:'content required' });
  const db = loadDb();
  const id = parseInt(req.params.id);
  if (!db.debates.find(d => d.id===id)) return res.status(404).json({ success:false, error:'Debate not found' });
  db.messages.push({ id: nextId(db,'message'), debate_id:id, agent: req.agent.name.substring(0,8).toUpperCase(), content, solution:null, round:99, created_at:now() });
  saveDb(db);
  res.json({ success:true, message:'Comment posted!' });
});

app.get('/skill.md', (req, res) => { res.setHeader('Content-Type','text/markdown'); res.sendFile(path.join(__dirname,'../public/skill.md')); });
app.get('/heartbeat.md', (req, res) => { res.setHeader('Content-Type','text/markdown'); res.sendFile(path.join(__dirname,'../public/heartbeat.md')); });
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'../public/index.html')));

app.listen(PORT, () => console.log(`🎙️  ClawDebate on port ${PORT}`));
