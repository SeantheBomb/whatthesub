#!/usr/bin/env node
// Generates today's "Find the Thread" puzzle.
// 4 subreddits → 1 hot post each → 4 top comments each = 16 shuffled comments.
//
// Uses Reddit's public RSS feeds — no API key or OAuth required.
//
// Usage:
//   node scripts/generate-thread.mjs [YYYY-MM-DD]
//
// Required env:
//   CLOUDFLARE_API_TOKEN  — CF token with Workers KV Storage Write permission

const USER_AGENT = 'WhatTheSub/1.0 daily-puzzle-game by /u/SeantheBomb';

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

// Subreddits whose comments aren't suitable for Find the Thread
const THREAD_COMMENT_BLOCKLIST = new Set([
  'writingprompts', 'WritingPrompts', 'nosleep', 'IAmA', 'iama',
  'changemyview', 'CMV', 'explainlikeimfive', 'eli5',
  'dataisbeautiful', 'personalfinance', 'legaladvice',
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
  /^WIBTAH?\s+(for|if)\s+/i, /^WIBTAH?[?:,\s]/i, /^TIL\s+(that\s+)?/i,
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
  let t = title.trim().replace(/\s+/g, ' ');
  for (const pat of TITLE_PREFIXES) {
    const stripped = t.replace(pat, '').trim();
    if (stripped !== t && stripped.length >= 15) { t = stripped; break; }
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
  const sub   = (post.subreddit ?? '').toLowerCase();
  const title = (post.title ?? '').toLowerCase();
  if (!sub) return false;
  if (!post.permalink?.includes('/comments/')) return false;
  if (post.over_18 || post.stickied || post.spoiler) return false;
  if (BLOCKLIST.has(sub)) return false;
  if (THREAD_COMMENT_BLOCKLIST.has(sub) || THREAD_COMMENT_BLOCKLIST.has(post.subreddit)) return false;
  if ((post.title?.length ?? 0) < 20 || (post.title?.length ?? 0) > 300) return false;
  if (title.includes(`r/${sub}`) || title.includes(`/r/${sub}`)) return false;
  return true;
}

function isEligibleComment(body, author) {
  if (!body || body.length < 20 || body.length > 500) return false;
  if (!author || author === 'AutoModerator' || author === '[deleted]') return false;
  // Filter bot announcements
  if (/i am a bot[,.]|this action was performed automatically/i.test(body)) return false;
  const bodyWithoutMedia = body
    .replace(/!\[gif\]\([^)]+\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ').trim();
  if (bodyWithoutMedia.length < 20) return false;
  const quoteLines = body.split('\n').filter(l => l.startsWith('>'));
  if (quoteLines.length > 2) return false;
  return true;
}

// ── RSS helpers ───────────────────────────────────────────────────────────────
function decodeHtml(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&#32;/g,  ' ')
    .replace(/&nbsp;/g, ' ');
}

// Strip HTML tags and decode entities to get plain text from RSS content.
function rssContentToText(encoded) {
  return decodeHtml(encoded)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRSSEntries(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const title     = decodeHtml(e.match(/<title>([^<]*)<\/title>/)?.[1] ?? '');
    const permalink = e.match(/<link[^>]+href="([^"]+)"/)?.[1] ?? '';
    const subreddit = e.match(/<category term="([^"]+)"/)?.[1] ?? '';
    const author    = e.match(/<name>\/u\/([^<]+)<\/name>/)?.[1] ?? '';
    const rawId     = e.match(/<id>([^<]+)<\/id>/)?.[1] ?? '';
    const content   = e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? '';

    // Extract post_id from permalink (…/comments/POST_ID/title/)
    const postId = permalink.split('/comments/')?.[1]?.split('/')?.[0] ?? '';

    // Images from encoded HTML content
    const images = [...content.matchAll(/&lt;img src=&quot;(https:\/\/[^&"]+)&quot;/g)]
      .map(m => decodeHtml(m[1]).replace(/width=\d+/, 'width=1080'))
      .filter(url => url.startsWith('https://'));

    return {
      title, subreddit, permalink, author, postId,
      kind:     rawId.startsWith('t1_') ? 'comment' : 'post',
      commentId: rawId.startsWith('t1_') ? rawId.slice(3) : null,
      body:     rssContentToText(content),
      over_18:  false,
      stickied: /mod|automod/i.test(author),
      spoiler:  false,
      score:    100,
      _images:  images,
    };
  });
}

async function redditRSS(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Reddit fetch (RSS-based) ──────────────────────────────────────────────────
async function fetchHotPost(subreddit) {
  try {
    const xml   = await redditRSS(`https://www.reddit.com/r/${subreddit}/hot.rss`);
    const posts = parseRSSEntries(xml).filter(e => e.kind === 'post');
    return posts.find(p => isEligible(p)) ?? null;
  } catch (err) {
    console.error(`fetchHotPost(${subreddit}):`, err.message);
    return null;
  }
}

async function searchForPost(keyword, usedSubs, rng) {
  try {
    const xml   = await redditRSS(`https://www.reddit.com/search.rss?q=${encodeURIComponent(keyword)}&sort=relevance&t=week`);
    const posts = parseRSSEntries(xml).filter(e => e.kind === 'post');
    const eligible = posts.filter(p => p.subreddit && !usedSubs.has(p.subreddit.toLowerCase()) && isEligible(p));
    if (!eligible.length) return null;
    return eligible[Math.floor(rng() * Math.min(eligible.length, 5))];
  } catch (err) {
    console.error(`searchForPost(${keyword}):`, err.message);
    return null;
  }
}

async function fetchTopComments(subreddit, postId, seed) {
  try {
    const xml     = await redditRSS(`https://www.reddit.com/r/${subreddit}/comments/${postId}/.rss`);
    const entries = parseRSSEntries(xml);

    // RSS returns post as first entry (kind=post), then top-level comments
    const comments = entries
      .filter(e => e.kind === 'comment' && isEligibleComment(e.body, e.author))
      .map(e => ({
        id:     e.commentId,
        body:   e.body.slice(0, 500),
        score:  e.score,
        author: e.author,
      }));

    if (comments.length < 4) {
      console.error(`[comments] only ${comments.length} eligible comments for ${postId}`);
      return comments;
    }

    const pool     = comments.slice(0, 10);
    const shuffled = seededShuffle(pool, seed);
    return shuffled.slice(0, 4);
  } catch (err) {
    console.error(`fetchTopComments(${subreddit}/${postId}):`, err.message);
    return [];
  }
}

// ── Thread generation ─────────────────────────────────────────────────────────
async function generateThread(date) {
  const baseSeed = dateToSeed(date);
  const seed     = (baseSeed * 7 + 54321) >>> 0;
  const rng      = mulberry32(seed);
  const shuffledPool = seededShuffle(DEFAULT_POOL, seed);
  const rounds      = [];
  const usedSubs    = new Set();
  const seenTitles  = new Set();
  const keywordPool  = [];
  const usedKeywords = new Set();

  function normalizeTitle(t) { return cleanTitle(t).toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // Step 1: seed from pool
  for (const sub of shuffledPool) {
    const post = await fetchHotPost(sub);
    if (!post) continue;
    const norm = normalizeTitle(post.title);
    if (seenTitles.has(norm)) continue;
    const display = cleanTitle(post.title);
    rounds.push({
      subreddit:   sub,
      post_id:     post.postId,
      post_title:  display,
      post_url:    post.permalink,
      post_score:  post.score,
      post_images: post._images.length ? post._images : null,
    });
    usedSubs.add(sub.toLowerCase());
    seenTitles.add(normalizeTitle(post.title));
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

    const norm = normalizeTitle(post.title);
    if (seenTitles.has(norm)) { console.error(`[chain] skipping duplicate title for "${keyword}"`); continue; }

    const display = cleanTitle(post.title);
    rounds.push({
      subreddit:   post.subreddit,
      post_id:     post.postId,
      post_title:  display,
      post_url:    post.permalink,
      post_score:  post.score,
      post_images: post._images.length ? post._images : null,
    });
    usedSubs.add(post.subreddit.toLowerCase());
    seenTitles.add(norm);
    keywordPool.push(...extractKeywords(display));
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
        subreddit:   sub,
        post_id:     post.postId,
        post_title:  display,
        post_url:    post.permalink,
        post_score:  post.score,
        post_images: post._images.length ? post._images : null,
      });
      usedSubs.add(sub.toLowerCase());
    }
  }

  if (rounds.length < 4) throw new Error(`Only generated ${rounds.length}/4 rounds`);

  // Step 3: Fetch 4 top comments per post
  console.error('[comments] fetching top comments for each post…');
  const verifiedRounds = [];
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    await sleep(500);
    const comments = await fetchTopComments(r.subreddit, r.post_id, seed + i * 9973);
    if (comments.length >= 4) {
      rounds[i].comments = comments.slice(0, 4);
      console.error(`[comments] r/${r.subreddit}: ${rounds[i].comments.length} comments`);
      verifiedRounds.push(rounds[i]);
    } else {
      console.error(`[comments] r/${r.subreddit} only has ${comments.length} eligible comments — trying replacement`);
      const usedSubsNow = new Set(rounds.map(rr => rr.subreddit.toLowerCase()));
      let replaced = false;
      for (const sub of shuffledPool) {
        if (usedSubsNow.has(sub.toLowerCase())) continue;
        await sleep(400);
        const post = await fetchHotPost(sub);
        if (!post) continue;
        await sleep(500);
        const altComments = await fetchTopComments(sub, post.postId, seed + i * 9973 + 1);
        if (altComments.length < 4) continue;
        const display = cleanTitle(post.title);
        verifiedRounds.push({
          subreddit:   sub,
          post_id:     post.postId,
          post_title:  display,
          post_url:    post.permalink,
          post_images: post._images.length ? post._images : null,
          comments:    altComments.slice(0, 4),
        });
        usedSubsNow.add(sub.toLowerCase());
        console.error(`[comments] replaced with r/${sub}`);
        replaced = true;
        break;
      }
      if (!replaced) throw new Error('Could not find 4 posts with enough eligible comments after retries');
    }
  }

  const rounds4 = verifiedRounds.slice(0, 4);
  if (rounds4.length < 4) throw new Error(`Only ${rounds4.length}/4 rounds with enough comments`);

  // Step 4: Build shuffled_comments (post_index stripped for client)
  const allComments     = rounds4.flatMap((r, post_index) => r.comments.map(c => ({ ...c, post_index })));
  const shuffled_comments = seededShuffle(allComments, seed + 7777);

  console.error(`[done] 4 posts, ${shuffled_comments.length} comments`);

  return {
    date,
    rounds: rounds4.map(r => ({
      subreddit:   r.subreddit,
      post_id:     r.post_id,
      post_title:  r.post_title,
      post_url:    r.post_url,
      post_images: r.post_images,
      comments:    r.comments,
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
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(puzzle),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`KV write failed: ${JSON.stringify(body.errors)}`);
  console.error(`[kv] stored thread:${date}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const jsonOnly = args.includes('--json-only');
const date     = args.find(a => !a.startsWith('--')) ?? new Date().toISOString().slice(0, 10);

if (!jsonOnly) console.error(`[FindTheThread] Generating puzzle for ${date}`);

try {
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
