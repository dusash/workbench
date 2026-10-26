/**
 * 每日新闻抓取脚本
 * 运行环境：GitHub Actions（Node 20+）
 * 输出：data/news.json（保留最近 3 天）
 *
 * 设计原则：
 *   1. 单源失败不影响整体，每个源独立 try-catch
 *   2. 行情取不到就显示 null，绝不拿昨天数字冒充今天
 *   3. AI 只做筛选和摘要，不生成内容
 *   4. AI 全部失败时降级为「只给标题+链接」，不输出空白
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'news.json');
const KEEP_DAYS = 3;

// 各板块的时间窗口（小时）。科技突破本来就稀少，窗口给宽一些。
const WINDOW = { ai: 36, tech: 96, us: 60, world: 72 };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ─────────────────────────── 新闻源配置 ───────────────────────────
// 按板块分组。每个板块抓到的候选条目会一起送进 AI 做筛选。
const FEEDS = {
  ai: [
    { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
    { name: 'The Decoder', url: 'https://the-decoder.com/feed/' },
    { name: '量子位', url: 'https://www.qbitai.com/feed' },
  ],
  tech: [
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
    { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },
  ],
  us: [
    { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  ],
  world: [
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml' },
    { name: 'CNBC World', url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html' },
  ],
};

// 权重股：纳指 / 标普里权重最高的几家，异动时单独提示
const WEIGHT_STOCKS = [
  { symbol: 'AAPL', name: '苹果' },
  { symbol: 'MSFT', name: '微软' },
  { symbol: 'NVDA', name: '英伟达' },
  { symbol: 'AMZN', name: '亚马逊' },
  { symbol: 'META', name: 'Meta' },
  { symbol: 'GOOGL', name: '谷歌' },
  { symbol: 'TSLA', name: '特斯拉' },
  { symbol: 'AVGO', name: '博通' },
];

const log = (...a) => console.log('•', ...a);

// ─────────────────────────── 工具函数 ───────────────────────────
function cleanText(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function pickAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}=["']([^"']+)["'][^>]*/?>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

/** 通用 RSS / Atom 解析，不依赖第三方库 */
function parseFeed(xml) {
  const out = [];
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const entries = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  const list = blocks.length ? blocks : entries;

  for (const b of list) {
    const title = cleanText(pick(b, 'title'));
    let link = cleanText(pick(b, 'link'));
    if (!link) link = pickAttr(b, 'link', 'href');
    const rawDate = pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || pick(b, 'dc:date');
    const desc = cleanText(pick(b, 'description') || pick(b, 'summary') || pick(b, 'content'));
    if (title && link) {
      out.push({ title, url: link.trim(), desc: desc.slice(0, 400), date: rawDate.trim() });
    }
  }
  return out;
}

/** URL 归一化：去掉跟踪参数和末尾斜杠，用于去重 */
function normUrl(u) {
  try {
    const x = new URL(u);
    const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'];
    drop.forEach((k) => x.searchParams.delete(k));
    return (x.origin + x.pathname).replace(/\/$/, '').toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

/** 标题指纹：去掉标点空格后取前 30 字符，用于跨源去重 */
function titleKey(t) {
  return String(t).toLowerCase().replace(/[\s\p{P}]/gu, '').slice(0, 30);
}

async function withTimeout(fn, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────── ① 行情 ───────────────────────────
/**
 * 依次尝试 Yahoo → 腾讯 → Sina。
 * 全部失败返回 null，由前端显示「行情获取失败」。
 */
async function getQuote() {
  const attempts = [
    { src: 'yahoo', fn: quoteYahoo },
    { src: 'tencent', fn: quoteTencent },
    { src: 'sina', fn: quoteSina },
  ];
  for (const a of attempts) {
    try {
      const r = await withTimeout(() => a.fn(), 12000, `行情/${a.src}`);
      if (r && r.items && r.items.length) {
        log(`行情来源：${a.src}，${r.items.length} 个指数`);
        return { ...r, source: a.src };
      }
    } catch (e) {
      log(`行情 ${a.src} 失败：${e.message}`);
    }
  }
  log('行情全部失败');
  return null;
}

async function quoteYahoo() {
  const syms = [
    { s: '%5EIXIC', name: '纳斯达克', key: 'IXIC' },
    { s: '%5EGSPC', name: '标普500', key: 'GSPC' },
  ];
  const items = [];
  let stamp = '';
  for (const { s, name, key } of syms) {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=5d`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    );
    if (!res.ok) throw new Error(`Yahoo ${key} HTTP ${res.status}`);
    const j = await res.json();
    const meta = j?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error(`Yahoo ${key} 无数据`);
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const price = meta.regularMarketPrice;
    const change = +(price - prev).toFixed(2);
    const pct = +((change / prev) * 100).toFixed(2);
    if (!stamp && meta.regularMarketTime) {
      // 转成美东时间，和用户看到的"收盘时间"一致
      stamp = new Date(meta.regularMarketTime * 1000).toLocaleString('sv-SE', {
        timeZone: 'America/New_York',
      });
    }
    items.push({ name, symbol: key, price: +price.toFixed(2), change, pct });
  }
  return { updated: stamp, updatedNote: '美东时间', items };
}

async function quoteTencent() {
  const map = [
    { q: 'usIXIC', name: '纳斯达克', key: 'IXIC' },
    { q: 'usINX', name: '标普500', key: 'INX' },
  ];
  const items = [];
  let stamp = '';
  for (const { q, name, key } of map) {
    const res = await fetch(`https://qt.gtimg.cn/q=${q}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`腾讯 ${key} HTTP ${res.status}`);
    const txt = await res.text(); // GBK 中文会乱码，但数字字段是 ASCII，不影响
    const f = txt.split('~');
    if (f.length < 33) throw new Error(`腾讯 ${key} 字段不足`);
    const price = parseFloat(f[3]);
    const change = parseFloat(f[31]);
    const pct = parseFloat(f[32]);
    const t = (f[30] || '').trim(); // 形如 2026-10-23 17:15:59
    if (!Number.isFinite(price)) throw new Error(`腾讯 ${key} 价格异常`);
    if (!stamp && t) stamp = t;
    items.push({
      name,
      symbol: key,
      price: +price.toFixed(2),
      change: +change.toFixed(2),
      pct: +pct.toFixed(2),
    });
  }
  return { updated: stamp, updatedNote: '美东时间', items };
}

async function quoteSina() {
  const map = [
    { q: 'gb_$ixic', name: '纳斯达克', key: 'IXIC' },
    { q: 'gb_$inx', name: '标普500', key: 'INX' },
  ];
  const items = [];
  let stamp = '';
  for (const { q, name, key } of map) {
    const res = await fetch(`https://hq.sinajs.cn/list=${q}`, {
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    });
    if (!res.ok) throw new Error(`Sina ${key} HTTP ${res.status}`);
    const txt = await res.text();
    const m = txt.match(/="([^"]*)"/);
    if (!m) throw new Error(`Sina ${key} 解析失败`);
    const f = m[1].split(',');
    if (f.length < 5) throw new Error(`Sina ${key} 字段不足`);
    const price = parseFloat(f[1]);
    const pct = parseFloat(f[2]);
    const change = parseFloat(f[4]);
    const t = (f[3] || '').trim();
    if (!Number.isFinite(price)) throw new Error(`Sina ${key} 价格异常`);
    if (!stamp && t) stamp = t;
    items.push({
      name,
      symbol: key,
      price: +price.toFixed(2),
      change: +change.toFixed(2),
      pct: +pct.toFixed(2),
    });
  }
  return { updated: stamp, updatedNote: '北京时间', items };
}

// ─────────────────────────── ② 新闻抓取 ───────────────────────────
async function grabSection(key, feeds) {
  const all = [];
  const failed = [];
  await Promise.all(
    feeds.map(async (f) => {
      try {
        const res = await withTimeout(
          () => fetch(f.url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml,application/xml,text/xml,*/*' } }),
          15000,
          f.name
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        const parsed = parseFeed(xml);
        if (!parsed.length) throw new Error('解析后 0 条');
        parsed.forEach((it) => all.push({ ...it, source: f.name, section: key }));
        log(`${f.name}：${parsed.length} 条`);
      } catch (e) {
        failed.push(`${f.name}（${e.message}）`);
        log(`${f.name} 失败：${e.message}`);
      }
    })
  );
  return { items: all, failed };
}

/** 去重 + 时效过滤 */
function refine(items, hours = 48) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const seenUrl = new Set();
  const seenTitle = new Set();
  const kept = [];
  for (const it of items) {
    const u = normUrl(it.url);
    const tk = titleKey(it.title);
    if (seenUrl.has(u) || seenTitle.has(tk)) continue;
    // 日期能解析就过滤，解析不了就保留（有些源没有 pubDate）
    const ts = it.date ? Date.parse(it.date) : NaN;
    if (Number.isFinite(ts) && ts < cutoff) continue;
    seenUrl.add(u);
    seenTitle.add(tk);
    kept.push({ ...it, ts: Number.isFinite(ts) ? ts : Date.now() });
  }
  kept.sort((a, b) => b.ts - a.ts);
  return kept;
}

// ─────────────────────────── ③ AI 筛选 + 摘要 ───────────────────────────
const SECTIONS = [
  { key: 'ai', name: 'AI 动态', want: 4, hint: 'AI 模型、产品、公司动向。普通融资/人事消息优先度低。' },
  { key: 'tech', name: '科技突破', want: 2, hint: '只挑真正改变可能性边界的研究或工程突破。普通产品发布、常规功能更新一律不选。' },
  { key: 'us', name: '美股行情', want: 3, hint: '美国股市、美联储、经济数据、影响大盘的政策与权重股异动。' },
  { key: 'world', name: '时政', want: 1, hint: '只挑影响全球市场或科技政策的重大事件，其余一律不选。' },
];

const SYSTEM_PROMPT = `你是一名严谨的新闻编辑，服务于一位中国计算机专业大一学生。
他的关注优先级：AI 与科技 > 美股与宏观 > 时政（只看大事）。

规则：
1. 只能从给定候选里挑选，禁止编造任何未出现的内容。
2. 每条摘要用一句中文说清「发生了什么」，不超过 45 字，不加评价、不加标题党。
3. 如果某个板块的候选全都不合格，就返回空数组 []，不要凑数。
4. 严格输出 JSON，不要 markdown 代码块。`;

function buildUserPrompt(section, items) {
  const list = items
    .slice(0, 40)
    .map((it, i) => `[${i}] (${it.source}) ${it.title}\n${it.desc || ''}`)
    .join('\n\n');
  return `板块：${section.name}
挑选标准：${section.hint}
最多挑 ${section.want} 条。

候选：
${list}

输出格式：
{"picked":[{"i":索引数字,"summary":"一句话中文摘要"}]}`;
}

/** 调用 crosery 中转（GitHub Models 已于 2026-07-30 退役，不再尝试） */
const aiErrors = [];

async function callAI(section, items) {
  try {
    const out = await withTimeout(() => callCrosery(section, items), 90000, 'AI/crosery');
    if (out) {
      log(`AI 完成「${section.name}」`);
      return { picked: out, provider: 'crosery' };
    }
  } catch (e) {
    const cause = e && e.cause ? ` [${e.cause.code || e.cause.message || String(e.cause)}]` : '';
    const msg = `crosery: ${String(e.message).slice(0, 80)}${cause}`;
    log(`AI 失败：${msg}`);
    aiErrors.push(msg);
  }
  return null;
}

async function callCrosery(section, items) {
  const key = process.env.CROSERY_KEY;
  const base = process.env.CROSERY_URL || 'https://ai.crosery.cn/v1';
  if (!key) throw new Error('无 CROSERY_KEY');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.CROSERY_MODEL || 'deepseek-v4.1-flash',
      temperature: 0.2,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(section, items) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  const raw = await res.json();
  // 该中转站把结果包在 data 里，和标准 OpenAI 格式不同
  const j = raw && raw.data ? raw.data : raw;
  const choice = j?.choices?.[0];
  if (!choice) throw new Error('返回无 choices: ' + JSON.stringify(raw).slice(0, 100));
  const content = choice.message?.content;
  if (!content && choice.finish_reason === 'length') throw new Error('输出被截断（max_tokens 不够）');
  return parseAIJson(content, items);
}

function parseAIJson(raw, items) {
  if (!raw) throw new Error('AI 返回空');
  const s = String(raw).replace(/```json|```/g, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 未返回 JSON');
  const obj = JSON.parse(m[0]);
  const picked = Array.isArray(obj.picked) ? obj.picked : [];
  const out = [];
  for (const p of picked) {
    const it = items[p.i];
    if (!it) continue;
    out.push({
      title: it.title,
      url: it.url,
      source: it.source,
      summary: cleanText(p.summary || '').slice(0, 90),
    });
  }
  return out;
}

/** 降级：不调 AI，按关键词粗筛后再取前几条（总比直接取前 N 条强） */
const FALLBACK_KW = {
  ai: /(ai\b|artificial intelligence|llm|openai|anthropic|deepmind|nvidia|gpt|gemini|claude|agent|robot|model)/i,
  tech: /(breakthrough|discover|researcher|scientist|first-ever|novel|unprecedented|quantum|fusion|chip|demonstrat|prove|achiev)/i,
  us: /(federal reserve|fed\b|s&p|nasdaq|dow jones|wall street|inflation|\bcpi\b|treasury|rate cut|rate hike|earnings|gdp|jobs report|stocks?|market)/i,
  world: /(war|election|sanction|treaty|summit|conflict|invasion|policy|government|parliament|president|minister|tariff)/i,
};

function fallbackPick(section, items) {
  const kw = FALLBACK_KW[section.key];
  const hit = kw ? items.filter((it) => kw.test(it.title + ' ' + (it.desc || ''))) : [];
  const pool = hit.length >= section.want ? hit : items;
  return pool.slice(0, section.want).map((it) => ({
    title: it.title,
    url: it.url,
    source: it.source,
    summary: '',
  }));
}

// ─────────────────────────── 主流程 ───────────────────────────
function todayKey(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

async function main() {
  const started = Date.now();
  const notes = [];

  // 1) 行情
  const quote = await getQuote();
  if (!quote) notes.push('行情获取失败');

  // 2) 抓取四个板块
  const bucket = {};
  for (const [k, feeds] of Object.entries(FEEDS)) {
    const { items, failed } = await grabSection(k, feeds);
    bucket[k] = refine(items, WINDOW[k] || 48);
    if (failed.length) notes.push(...failed.map((f) => `源失败：${f}`));
    log(`「${k}」候选 ${bucket[k].length} 条`);
  }

  // 3) AI 筛选 + 摘要
  const sections = [];
  let aiOk = 0;
  for (const s of SECTIONS) {
    const cand = bucket[s.key] || [];
    if (!cand.length) {
      sections.push({ key: s.key, name: s.name, items: [] });
      continue;
    }
    let picked = null;
    if (cand.length) {
      const r = await callAI(s, cand);
      if (r && r.picked.length) {
        picked = r.picked;
        aiOk++;
      }
    }
    const items = picked && picked.length ? picked : fallbackPick(s, cand);
    sections.push({ key: s.key, name: s.name, items });
  }

  // 4) 权重股异动（给 AI 的补充信号，也直接展示）
  let hotStocks = [];
  if (quote?.items?.length) {
    hotStocks = await checkWeightStocks().catch(() => []);
  }

  // 5) 组装当天数据
  const today = {
    date: todayKey(),
    generatedAt: new Date().toISOString(),
    quote: quote
      ? { updated: quote.updated, note: quote.updatedNote || '', source: quote.source, items: quote.items }
      : null,
    hotStocks,
    sections,
  };

  // 6) 合并历史，保留 3 天
  let history = [];
  try {
    const old = JSON.parse(await fs.readFile(OUT, 'utf8'));
    history = Array.isArray(old.days) ? old.days : [];
  } catch {
    history = [];
  }
  const map = new Map(history.map((d) => [d.date, d]));
  map.set(today.date, today);
  const days = [...map.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP_DAYS);

  const status = aiOk >= 2 ? 'ok' : aiOk > 0 ? 'partial' : 'fallback';
  if (aiOk < 4 && aiErrors.length) notes.push(...aiErrors.slice(0, 4));
  const payload = {
    version: 1,
    status,
    aiSections: aiOk,
    generatedAt: new Date().toISOString(),
    notes: [...new Set(notes)].slice(0, 12),
    days,
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');

  log(`完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s，状态 ${status}`);
  log(`输出 ${OUT}`);
}

/** 权重股异动检测：单日涨跌幅绝对值 > 5% 视为异动 */
async function checkWeightStocks() {
  const out = [];
  for (const s of WEIGHT_STOCKS) {
    try {
      const res = await withTimeout(
        () => fetch(`https://qt.gtimg.cn/q=us${s.symbol}`, { headers: { 'User-Agent': UA } }),
        8000,
        s.symbol
      );
      if (!res.ok) continue;
      const f = (await res.text()).split('~');
      const price = parseFloat(f[3]);
      const pct = parseFloat(f[32]);
      if (Number.isFinite(pct) && Math.abs(pct) >= 5) {
        out.push({ name: s.name, symbol: s.symbol, price: +price.toFixed(2), pct: +pct.toFixed(2) });
      }
    } catch {
      /* 单个股票失败忽略 */
    }
  }
  if (out.length) log(`权重股异动：${out.map((o) => `${o.name}${o.pct}%`).join('、')}`);
  return out;
}

main().catch((e) => {
  console.error('致命错误：', e);
  process.exit(1);
});
