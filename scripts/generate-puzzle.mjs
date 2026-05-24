#!/usr/bin/env node
// Runs in GitHub Actions (or locally) — no Cloudflare subrequest limits apply here.
// Generates today's puzzle and writes it directly to KV via the REST API.
//
// Usage:
//   node scripts/generate-puzzle.mjs [YYYY-MM-DD]
//
// Required env:
//   CLOUDFLARE_API_TOKEN  — CF token with Workers KV Storage Write permission
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
//     — Reddit Script app credentials (see scripts/reddit.mjs for setup instructions)

import { initReddit, redditHeaders, redditBase } from './reddit.mjs';

const ACCOUNT_ID    = '82fcff5fb1a0de92c409f86edd495985';
const KV_NAMESPACE  = '010130a100d74b3f9e43f6147ed22444';
const PUZZLE_TTL    = 90000; // seconds (~25 hours)

// ── Subreddit pool ────────────────────────────────────────────────────────────
const DEFAULT_POOL = [
  'AskReddit', 'worldnews', 'gaming', 'technology', 'science',
  'movies', 'Music', 'sports', 'food', 'Cooking',
  'funny', 'aww', 'todayilearned', 'LifeProTips', 'explainlikeimfive',
  'tifu', 'mildlyinteresting', 'dataisbeautiful', 'Showerthoughts', 'interestingasfuck',
  'Unexpected', 'MadeMeSmile', 'oddlysatisfying', 'nextfuckinglevel', 'DIY',
  'personalfinance', 'relationship_advice', 'AmItheAsshole', 'legaladvice', 'history',
  'space', 'Futurology', 'books', 'television', 'nfl',
  'nba', 'soccer', 'programming', 'learnprogramming', 'ProgrammerHumor',
  'photoshopbattles', 'memes', 'wholesomememes', 'NatureIsFuckingLit', 'EarthPorn',
  'GetMotivated', 'WritingPrompts', 'nosleep', 'IAmA', 'news',
  'UpliftingNews', 'philosophy', 'creepy', 'Documentaries', 'OldSchoolCool',
  'nottheonion', 'facepalm', 'blackpeopletwitter', 'whitepeopletwitter', 'gifs',
];

const BLOCKLIST = new Set([
  'nsfw', 'gonewild', 'nofap', 'drugs', 'darkjokes', 'teenagers',
  'subredditdrama', 'SubredditDrama', 'metareddit', 'redditmeta',
  'announcements', 'changelog', 'blog',
]);

const STOP_WORDS = new Set([
  'a','an','the','this','that','these','those','some','any','all','both',
  'each','few','more','most','other','such','no','own','same',
  'i','me','my','myself','we','our','ours','you','your','yours','he','him',
  'his','himself','she','her','hers','herself','it','its','itself','they',
  'them','their','theirs','what','which','who','whom',
  'am','is','are','was','were','be','been','being','have','has','had',
  'having','do','does','did','doing','will','would','could','should','may',
  'might','must','shall','can',
  'at','by','for','with','about','against','between','into','through',
  'during','before','after','above','below','from','up','down','in','out',
  'off','over','under','again','further','once','to','of','on','and','but',
  'or','nor','so','yet','as','while','because','if','unless','until','when',
  'where','why','how','than',
  'also','here','there','then','ever','just','very','only','well','back',
  'like','know','take','came','made','come','make','good','true','sure',
  'went','done','said','time','year','look','life','want','need','feel',
  'tell','find','give','keep','left','next','open','stay','stop','talk',
  'turn','used','work','real','help','high','long','away','after','again',
  'never','every','still','think','going','heard','asked','thing','things',
  'people','really','always','already','since','quite','maybe','their',
  'right','today','point','place','years','start','first','last','even',
  'much','many','another','without','through','between','around','almost',
  'reddit','upvote','downvote','karma','post','comment','thread','repost',
  'crosspost','subreddit','redditor','update','edit','tldr','rant','story',
  'title','caption','context','question','literally','basically','actually',
  'honestly','seriously','definitely','probably','obviously','clearly',
  'simply','pretty','perhaps','though','although','anyone','someone',
  'everyone','nothing','something','everything','somewhere','nowhere',
  'number','second','third','nothing',
]);

const TITLE_PREFIXES = [
  /^TIFU\s+by\s+/i,
  /^AITA\s+(for|if|that|when)\s+/i,
  /^AITA[?:,\s]/i,
  /^WIBTA\s+(for|if)\s+/i,
  /^WIBTA[?:,\s]/i,
  /^TIL\s+(that\s+)?/i,
  /^TIL[:\s,]/i,
  /^LPT\s*request?[:\s]/i,
  /^LPT[:\s]/i,
  /^ELI5[:\s]/i,
  /^CMV[:\s]/i,
  /^YSK[:\s]/i,
  /^DAE\s+/i,
  /^PSA[:\s]/i,
  /^\[OC\]\s*/i,
  /^\[Update\]\s*/i,
  /^\[Serious\]\s*/i,
  /^\[Discussion\]\s*/i,
  /^Update[:\s]/i,
];

// ── PRNG ──────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dateToSeed(dateStr) {
  return dateStr.split('-').reduce((acc, n) => acc * 1000 + parseInt(n, 10), 0);
}

function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanTitle(title) {
  let t = title.trim();
  for (const pat of TITLE_PREFIXES) {
    const stripped = t.replace(pat, '').trim();
    if (stripped.length >= 15) { t = stripped; break; }
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function extractKeywords(title) {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

function isEligible(post) {
  if (!post) return false;
  const sub = post.subreddit.toLowerCase();
  const title = (post.title ?? '').toLowerCase();
  return (
    !post.over_18 &&
    !post.stickied &&
    !post.spoiler &&
    !BLOCKLIST.has(sub) &&
    post.score >= 50 &&
    post.title.length >= 20 &&
    post.title.length <= 300 &&
    !title.includes(`r/${sub}`) &&
    !title.includes(`/r/${sub}`)
  );
}

function extractImages(post) {
  if (post.is_gallery && post.gallery_data?.items && post.media_metadata) {
    const urls = post.gallery_data.items
      .filter(item => !item.is_deleted)
      .map(item => {
        const meta = post.media_metadata[item.media_id];
        if (!meta || meta.status !== 'valid' || !['Image', 'AnimatedImage'].includes(meta.e)) return null;
        const previews = meta.p ?? [];
        const best = previews[previews.length - 1];
        const url = best?.u ?? meta.s?.u;
        return typeof url === 'string' && url.startsWith('https://') ? url : null;
      })
      .filter(Boolean);
    if (urls.length) return urls;
  }

  if (post.post_hint === 'image' && /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(post.url ?? '')) {
    return [post.url];
  }

  const src = post.preview?.images?.[0]?.source?.url;
  if (typeof src === 'string' && src.startsWith('https://')) return [src];

  return null;
}

// ── Reddit fetch ──────────────────────────────────────────────────────────────

async function fetchHotPost(subreddit) {
  const url = `${redditBase()}/r/${subreddit}/hot.json?limit=15&raw_json=1`;
  try {
    const res = await fetch(url, { headers: redditHeaders() });
    if (!res.ok) { console.error(`fetchHotPost(${subreddit}): HTTP ${res.status}`); return null; }
    const data = await res.json();
    const posts = (data?.data?.children ?? []).map(p => p.data);
    return posts.find(isEligible) ?? null;
  } catch (err) {
    console.error(`fetchHotPost(${subreddit}):`, err.message);
    return null;
  }
}

async function searchForPost(keyword, usedSubs, rng) {
  const url = `${redditBase()}/search.json?q=${encodeURIComponent(keyword)}&sort=relevance&t=week&limit=25&raw_json=1`;
  try {
    const res = await fetch(url, { headers: redditHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const posts = (data?.data?.children ?? []).map(p => p.data);
    const eligible = posts.filter(p => !usedSubs.has(p.subreddit.toLowerCase()) && isEligible(p));
    if (!eligible.length) return null;
    return eligible[Math.floor(rng() * Math.min(eligible.length, 5))];
  } catch (err) {
    console.error(`searchForPost(${keyword}):`, err.message);
    return null;
  }
}

// ── Unified keyword attempt ───────────────────────────────────────────────────
async function tryUnifiedChain(keyword, seedRound, seed) {
  const url = `${redditBase()}/search.json?q=${encodeURIComponent(keyword)}&sort=relevance&t=week&limit=50&raw_json=1`;
  try {
    const res = await fetch(url, { headers: redditHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const posts = (data?.data?.children ?? []).map(p => p.data);

    // Deduplicate by subreddit, filter to eligible posts in new subs
    const usedSubs = new Set([seedRound.subreddit.toLowerCase()]);
    const seen = new Set([seedRound.subreddit.toLowerCase()]);
    const candidates = [];
    for (const p of posts) {
      const sub = p.subreddit.toLowerCase();
      if (seen.has(sub) || !isEligible(p)) continue;
      seen.add(sub);
      candidates.push(p);
    }

    if (candidates.length < 5) return null;

    // Seeded shuffle so different dates pick different orderings
    const shuffled = seededShuffle(candidates, seed + 991);
    const rounds = [seedRound];

    for (const post of shuffled) {
      if (rounds.length >= 6) break;
      const sub = post.subreddit.toLowerCase();
      if (usedSubs.has(sub)) continue;
      const display = cleanTitle(post.title);
      rounds.push({
        subreddit: post.subreddit,
        post_title: display,
        post_url: `https://reddit.com${post.permalink}`,
        post_score: post.score,
        post_images: extractImages(post),
        linking_keyword: keyword,
      });
      usedSubs.add(sub);
    }

    return rounds.length >= 6 ? rounds : null;
  } catch (err) {
    console.error(`tryUnifiedChain(${keyword}):`, err.message);
    return null;
  }
}

// ── Puzzle generation ─────────────────────────────────────────────────────────
async function generatePuzzle(date) {
  const seed = dateToSeed(date);
  const rng = mulberry32(seed);
  const shuffledPool = seededShuffle(DEFAULT_POOL, seed);
  const rounds = [];
  const usedSubs = new Set();
  const keywordPool = [];
  const usedKeywords = new Set();

  // Step 1: seed from pool
  for (const sub of shuffledPool) {
    const post = await fetchHotPost(sub);
    if (!post) continue;
    const display = cleanTitle(post.title);
    rounds.push({
      subreddit: sub,
      post_title: display,
      post_url: `https://reddit.com${post.permalink}`,
      post_score: post.score,
      post_images: extractImages(post),
      linking_keyword: null,
    });
    usedSubs.add(sub.toLowerCase());
    keywordPool.push(...extractKeywords(display));
    console.error(`[seed] r/${sub} → "${display.slice(0, 60)}"`);
    break;
  }

  if (!rounds.length) throw new Error('Could not fetch a starting post from pool');

  // ── Step 2: Try unified keyword ─────────────────────────────────────────────
  const seedKeywords = extractKeywords(rounds[0].post_title);
  const keywordsToTry = seededShuffle(seedKeywords, seed + 991).slice(0, 6);
  let unifiedResult = null;

  for (const keyword of keywordsToTry) {
    console.error(`[unified] trying "${keyword}"`);
    await sleep(300);
    const attempt = await tryUnifiedChain(keyword, rounds[0], seed);
    if (attempt) {
      console.error(`[unified] success with "${keyword}"`);
      unifiedResult = { rounds: attempt, unified_keyword: keyword };
      break;
    }
    console.error(`[unified] failed with "${keyword}"`);
  }

  if (unifiedResult) {
    const shuffled_options = seededShuffle(unifiedResult.rounds.map(r => r.subreddit), seed + 7919);
    return {
      date,
      puzzle_type: 'unified',
      unified_keyword: unifiedResult.unified_keyword,
      rounds: unifiedResult.rounds,
      shuffled_options,
      generated_at: new Date().toISOString(),
    };
  }

  // ── Step 3: Keyword chain fallback ─────────────────────────────────────────
  let attempts = 0;
  while (rounds.length < 6 && attempts < 50) {
    attempts++;
    const available = keywordPool.filter(k => !usedKeywords.has(k));
    if (!available.length) { console.error('[chain] keyword pool exhausted'); break; }

    const keyword = available[Math.floor(rng() * available.length)];
    usedKeywords.add(keyword);
    console.error(`[chain] searching "${keyword}" (attempt ${attempts}, have ${rounds.length}/6)`);
    await sleep(300);

    const post = await searchForPost(keyword, usedSubs, rng);
    if (!post) { console.error(`[chain] no eligible post for "${keyword}"`); continue; }

    const display = cleanTitle(post.title);
    rounds.push({
      subreddit: post.subreddit,
      post_title: display,
      post_url: `https://reddit.com${post.permalink}`,
      post_score: post.score,
      post_images: extractImages(post),
      linking_keyword: keyword,
    });
    usedSubs.add(post.subreddit.toLowerCase());
    const newKeywords = extractKeywords(display);
    keywordPool.push(...newKeywords);
    console.error(`[chain] r/${post.subreddit} via "${keyword}" → "${display.slice(0, 60)}"`);
  }

  // Fallback: fill from pool
  if (rounds.length < 6) {
    console.error(`[fallback] chain got ${rounds.length}/6 — filling from pool`);
    for (const sub of shuffledPool) {
      if (rounds.length >= 6) break;
      if (usedSubs.has(sub.toLowerCase())) continue;
      const post = await fetchHotPost(sub);
      if (!post) continue;
      const display = cleanTitle(post.title);
      rounds.push({
        subreddit: sub,
        post_title: display,
        post_url: `https://reddit.com${post.permalink}`,
        post_score: post.score,
        post_images: extractImages(post),
        linking_keyword: null,
      });
      usedSubs.add(sub.toLowerCase());
    }
  }

  if (rounds.length < 6) throw new Error(`Only generated ${rounds.length}/6 rounds`);

  const shuffled_options = seededShuffle(rounds.map(r => r.subreddit), seed + 7919);
  return { date, puzzle_type: 'chained', unified_keyword: null, rounds, shuffled_options, generated_at: new Date().toISOString() };
}

// ── KV write ──────────────────────────────────────────────────────────────────
async function writeToKV(date, puzzle) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN env var is required');

  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE}/values/puzzle%3A${date}?expiration_ttl=${PUZZLE_TTL}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(puzzle),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`KV write failed: ${JSON.stringify(body.errors)}`);
  console.error(`[kv] stored puzzle:${date}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const jsonOnly = args.includes('--json-only');
const date = args.find(a => !a.startsWith('--')) ?? new Date().toISOString().slice(0, 10);

if (!jsonOnly) console.error(`[WhatTheSub] Generating puzzle for ${date}`);

try {
  await initReddit();
  const puzzle = await generatePuzzle(date);
  if (jsonOnly) {
    // Output JSON to stdout for piping to wrangler kv put
    process.stdout.write(JSON.stringify(puzzle));
  } else {
    console.error(`[WhatTheSub] Generated — chain: ${
      puzzle.rounds.map(r => r.linking_keyword ? `"${r.linking_keyword}"→${r.subreddit}` : r.subreddit).join(' | ')
    }`);
    await writeToKV(date, puzzle);
    console.error('[WhatTheSub] Done.');
  }
} catch (err) {
  console.error('[WhatTheSub] Failed:', err.message);
  process.exit(1);
}
