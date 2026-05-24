#!/usr/bin/env node
// Generates today's "Find the Thread" puzzle.
// 4 subreddits → 1 hot post each → 4 top comments each = 16 shuffled comments.
//
// Usage:
//   node scripts/generate-thread.mjs [YYYY-MM-DD]
//
// Required env:
//   CLOUDFLARE_API_TOKEN  — CF token with Workers KV Storage Write permission
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
//     — Reddit Script app credentials (see scripts/reddit.mjs)

import { initReddit, redditHeaders, redditBase } from './reddit.mjs';

const ACCOUNT_ID   = '82fcff5fb1a0de92c409f86edd495985';
const KV_NAMESPACE = '010130a100d74b3f9e43f6147ed22444';
const THREAD_TTL   = 90000; // seconds (~25 hours)

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
  /^TIFU\s+by\s+/i, /^AITA\s+(for|if|that|when)\s+/i, /^AITA[?:,\s]/i,
  /^WIBTA\s+(for|if)\s+/i, /^WIBTA[?:,\s]/i, /^TIL\s+(that\s+)?/i,
  /^TIL[:\s,]/i, /^LPT\s*request?[:\s]/i, /^LPT[:\s]/i, /^ELI5[:\s]/i,
  /^CMV[:\s]/i, /^YSK[:\s]/i, /^DAE\s+/i, /^PSA[:\s]/i,
  /^\[OC\]\s*/i, /^\[Update\]\s*/i, /^\[Serious\]\s*/i,
  /^\[Discussion\]\s*/i, /^Update[:\s]/i,
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
    !post.over_18 && !post.stickied && !post.spoiler &&
    !BLOCKLIST.has(sub) &&
    post.score >= 50 &&
    post.title.length >= 20 &&
    post.title.length <= 300 &&
    !title.includes(`r/${sub}`) &&
    !title.includes(`/r/${sub}`)
  );
}

function isEligibleComment(c) {
  const body = (c.body ?? '').trim();
  if (body === '[deleted]' || body === '[removed]') return false;
  if (body.length < 20 || body.length > 500) return false;
  if (c.score < 2) return false;
  if (c.stickied) return false;
  if (c.author === 'AutoModerator' || c.author === '[deleted]') return false;
  if (!(c.parent_id ?? '').startsWith('t3_')) return false; // top-level only
  // Reject if stripping URLs leaves less than 20 chars of real text
  const bodyWithoutUrls = body.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (bodyWithoutUrls.length < 20) return false;
  // Skip quote-heavy replies
  const quoteLines = body.split('\n').filter(l => l.startsWith('&gt;') || l.startsWith('>'));
  if (quoteLines.length > 2) return false;
  return true;
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

async function fetchTopComments(subreddit, postId, seed) {
  const url = `${redditBase()}/r/${subreddit}/comments/${postId}.json?sort=top&limit=25&raw_json=1`;
  try {
    const res = await fetch(url, { headers: redditHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    // data is [postListing, commentListing]
    const commentChildren = data?.[1]?.data?.children ?? [];
    const comments = commentChildren
      .filter(c => c.kind === 't1' && isEligibleComment(c.data))
      .map(c => ({
        id: c.data.id,
        body: c.data.body.trim().slice(0, 500),
        score: c.data.score,
        author: c.data.author,
      }));

    if (comments.length < 4) {
      console.error(`[comments] only ${comments.length} eligible comments for ${postId}`);
      return comments;
    }

    // Seeded pick of 4 from top candidates (up to first 10 eligible)
    const rng = mulberry32(seed);
    const pool = comments.slice(0, 10);
    const shuffled = seededShuffle(pool, seed);
    return shuffled.slice(0, 4);
  } catch (err) {
    console.error(`fetchTopComments(${subreddit}/${postId}):`, err.message);
    return [];
  }
}

// ── Thread generation ─────────────────────────────────────────────────────────
async function generateThread(date) {
  // Use a different seed than the puzzle to get different subreddits
  const baseSeed = dateToSeed(date);
  const seed = (baseSeed * 7 + 54321) >>> 0; // force unsigned 32-bit
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
      post_id: post.id,
      post_title: display,
      post_url: `https://reddit.com${post.permalink}`,
      post_score: post.score,
      post_images: extractImages(post),
    });
    usedSubs.add(sub.toLowerCase());
    keywordPool.push(...extractKeywords(display));
    console.error(`[seed] r/${sub} → "${display.slice(0, 60)}"`);
    break;
  }

  if (!rounds.length) throw new Error('Could not fetch a starting post from pool');

  // Step 2: chain to get 3 more subreddits (total 4)
  let attempts = 0;
  while (rounds.length < 4 && attempts < 40) {
    attempts++;
    const available = keywordPool.filter(k => !usedKeywords.has(k));
    if (!available.length) { console.error('[chain] keyword pool exhausted'); break; }

    const keyword = available[Math.floor(rng() * available.length)];
    usedKeywords.add(keyword);
    console.error(`[chain] searching "${keyword}" (attempt ${attempts}, have ${rounds.length}/4)`);
    await sleep(400);

    const post = await searchForPost(keyword, usedSubs, rng);
    if (!post) { console.error(`[chain] no eligible post for "${keyword}"`); continue; }

    const display = cleanTitle(post.title);
    rounds.push({
      subreddit: post.subreddit,
      post_id: post.id,
      post_title: display,
      post_url: `https://reddit.com${post.permalink}`,
      post_score: post.score,
      post_images: extractImages(post),
    });
    usedSubs.add(post.subreddit.toLowerCase());
    const newKeywords = extractKeywords(display);
    keywordPool.push(...newKeywords);
    console.error(`[chain] r/${post.subreddit} via "${keyword}" → "${display.slice(0, 60)}"`);
  }

  // Fallback: fill from pool
  if (rounds.length < 4) {
    console.error(`[fallback] chain got ${rounds.length}/4 — filling from pool`);
    for (const sub of shuffledPool) {
      if (rounds.length >= 4) break;
      if (usedSubs.has(sub.toLowerCase())) continue;
      const post = await fetchHotPost(sub);
      if (!post) continue;
      await sleep(200);
      const display = cleanTitle(post.title);
      rounds.push({
        subreddit: sub,
        post_id: post.id,
        post_title: display,
        post_url: `https://reddit.com${post.permalink}`,
        post_score: post.score,
        post_images: extractImages(post),
      });
      usedSubs.add(sub.toLowerCase());
    }
  }

  if (rounds.length < 4) throw new Error(`Only generated ${rounds.length}/4 rounds`);

  // Step 3: Fetch 4 top comments for each post
  console.error('[comments] fetching top comments for each post…');
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    await sleep(500);
    const comments = await fetchTopComments(r.subreddit, r.post_id, seed + i * 9973);
    if (comments.length < 4) {
      throw new Error(`r/${r.subreddit} post "${r.post_id}" only has ${comments.length} eligible comments`);
    }
    rounds[i].comments = comments.slice(0, 4);
    console.error(`[comments] r/${r.subreddit}: ${rounds[i].comments.length} comments fetched`);
  }

  // Step 4: Build shuffled_comments array (strips post_index for client; server retains it in KV)
  const allComments = rounds.flatMap((r, post_index) =>
    r.comments.map(c => ({ ...c, post_index }))
  );
  const shuffled_comments = seededShuffle(allComments, seed + 7777);

  console.error(`[done] 4 posts, ${shuffled_comments.length} comments`);

  return {
    date,
    rounds: rounds.map(r => ({
      subreddit: r.subreddit,
      post_id: r.post_id,
      post_title: r.post_title,
      post_url: r.post_url,
      post_images: r.post_images,
      comments: r.comments, // includes all 4 comments with their ids
    })),
    shuffled_comments,
    generated_at: new Date().toISOString(),
  };
}

// ── KV write ──────────────────────────────────────────────────────────────────
async function writeToKV(date, puzzle) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN env var is required');

  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE}/values/thread%3A${date}?expiration_ttl=${THREAD_TTL}`;
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
  console.error(`[kv] stored thread:${date}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const jsonOnly = args.includes('--json-only');
const date = args.find(a => !a.startsWith('--')) ?? new Date().toISOString().slice(0, 10);

if (!jsonOnly) console.error(`[FindTheThread] Generating puzzle for ${date}`);

try {
  await initReddit();
  const puzzle = await generateThread(date);
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(puzzle));
  } else {
    console.error(`[FindTheThread] Generated — subs: ${puzzle.rounds.map(r => r.subreddit).join(', ')}`);
    await writeToKV(date, puzzle);
    console.error('[FindTheThread] Done.');
  }
} catch (err) {
  console.error('[FindTheThread] Failed:', err.message);
  process.exit(1);
}
