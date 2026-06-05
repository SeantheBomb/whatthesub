#!/usr/bin/env node
// Runs in GitHub Actions (or locally) — no Cloudflare subrequest limits apply here.
// Generates today's puzzle and writes it directly to KV via the REST API.
//
// Uses Reddit's public RSS feeds (no API key or OAuth required).
// RSS works from any IP (cloud, residential, CI) unlike the JSON API.
//
// Usage:
//   node scripts/generate-puzzle.mjs [YYYY-MM-DD]
//
// Required env:
//   CLOUDFLARE_API_TOKEN  — CF token with Workers KV Storage Write permission

const USER_AGENT = 'WhatTheSub/1.0 daily-puzzle-game by /u/SeantheBomb';

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

// Per-subreddit terms that directly reveal the subreddit in a post title.
// Keys are lowercase subreddit names. Values are arrays of strings that,
// if found in a post title (case-insensitive, whole-word match), cause the
// post to be rejected entirely rather than just stripped.
// Add to this list whenever playtesters spot a new giveaway.
const SUBREDDIT_GIVEAWAYS = {
  // Acronym/abbreviation giveaways
  todayilearned:      ['til'],
  tifu:               ['tifu'],
  AmItheAsshole:      ['aita', 'wibta', 'nta', 'yta', 'esh', 'nah'],
  explainlikeimfive:  ['eli5'],
  LifeProTips:        ['lpt'],
  changemyview:       ['cmv'],
  // Sports league acronyms (too short for automatic token check)
  nba:                ['nba'],
  nfl:                ['nfl'],
  nhl:                ['nhl'],
  mlb:                ['mlb'],
  ufc:                ['ufc', 'mma'],
  mls:                ['mls'],
  nba2k:              ['nba', '2k'],
  cfb:                ['cfb'],
  // Era/topic giveaways
  '90s':              ['y2k', '1990s', "90's", '90s'],
  '80s':              ['1980s', "80's", '80s'],
  '70s':              ['1970s', "70's", '70s'],
  vinyl:              ['vinyl', 'record', 'turntable', 'rpm'],
  cars:               ['mph', 'horsepower', 'torque'],
  shitposting:        ['shitpost'],
  mildlyinfuriating:  ['mildly infuriating'],
  mildlyinteresting:  ['mildly interesting'],
  nottheonion:        ['onion'],
  facepalm:           ['facepalm'],
  Showerthoughts:     ['shower thought'],
  pettyrevenge:       ['petty revenge'],
  ProRevenge:         ['pro revenge'],
  NuclearRevenge:     ['nuclear revenge'],
  confession:         ['confession'],
  unpopularopinion:   ['unpopular opinion'],
  legaladvice:        ['legal advice', 'lawyer', 'attorney', 'lawsuit'],
  relationship_advice:['relationship advice'],
};

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
  /^WIBTAH?\s+(for|if)\s+/i,
  /^WIBTAH?[?:,\s]/i,
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

// Meta/discussion thread patterns — these almost always name the fandom/team.
const META_POST_RE = [
  /\bdiscussion\s+thread\b/i,
  /\bepisode\s+discussion\b/i,
  /\bpost[- ]?episode\b/i,
  /\bpost[- ]?game\b/i,
  /\bgame\s+thread\b/i,
  /\blive\s+(discussion|thread|chat)\b/i,
  /\bmegathread\b/i,
  /\bweekly\s+(discussion|thread|chat)\b/i,
  /\bdaily\s+(discussion|thread|chat)\b/i,
  /\bseries\s+finale\b/i,
  /\bs\d{1,2}\s*[ex]\s*\d{1,2}\b/i,        // S9E1, S05x08
  /\bseason\s+\d+[^a-z]*episode\s+\d+\b/i, // "Season 5 Episode 8"
  /^\[(?!OC\]|Serious\]|Update\])[^\]]{2,}\]/i, // [Highlight], [Trade], [Report], etc.
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
  // Try each prefix pattern. Use replaceAll-safe single replace on the string.
  // Some Reddit titles use non-breaking spaces or other Unicode whitespace after
  // the acronym — normalise whitespace first so patterns match reliably.
  t = t.replace(/\s+/g, ' ');
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

// Break a subreddit name into meaningful words to check against post titles.
// Handles CamelCase (TheBoys→["boys"]), underscores (real_housewives),
// and embedded connectors in all-lowercase names (rickandmorty→["rick","morty"]).
function subWordTokens(subreddit) {
  let s = subreddit
    .replace(/_+/g, ' ')                       // underscores
    .replace(/([a-z])([A-Z])/g, '$1 $2')       // camelCase split
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2') // ACRONYMWord
    .toLowerCase();
  // For still-contiguous long tokens, try splitting on embedded connector words
  s = s.replace(/[a-z]{6,}/g, tok =>
    tok.replace(/(and|the|of)/g, ' $1 ')
  );
  // Short subreddits (≤4 alpha chars: nba, AIO, DIY) use 3-char minimum so
  // the acronym itself is checked against the title.
  const minLen = subreddit.replace(/[^a-z]/gi, '').length <= 4 ? 3 : 4;
  return [...new Set(
    s.split(/\s+/)
     .map(w => w.replace(/[^a-z]/g, ''))
     .filter(w => w.length >= minLen && !STOP_WORDS.has(w))
  )];
}

// ── Jaccard similarity ────────────────────────────────────────────────────────
// Operates on Sets of keyword strings.
// Returns 0 when both sets are empty; 1 when identical.
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) { if (setB.has(w)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isEligible(post) {
  if (!post) return false;
  const sub   = post.subreddit.toLowerCase();
  const title = (post.title ?? '').toLowerCase();

  if (post.over_18 || post.stickied || post.spoiler) return false;
  if (BLOCKLIST.has(sub)) return false;
  if (post.score < 50) return false;
  if (post.title.length < 20 || post.title.length > 150) return false;

  // Require a real post URL (must contain /comments/) and a non-empty subreddit
  if (!sub) return false;
  if (!post.permalink?.includes('/comments/')) return false;

  // Reject if the post explicitly names its own subreddit
  if (title.includes(`r/${sub}`) || title.includes(`/r/${sub}`)) return false;

  // Reject episode/game/season discussion threads — they almost always name the fandom
  for (const re of META_POST_RE) {
    if (re.test(post.title)) return false;
  }

  // Reject if any meaningful word from the subreddit name appears in the title.
  // Handles CamelCase (TheBoys→"boys"), underscores, and embedded connectors
  // (rickandmorty→"rick","morty"). Trailing s is optional to catch possessives
  // ("widows" token matches "widow's bay"). Whole-word, case-insensitive.
  for (const tok of subWordTokens(post.subreddit)) {
    const stem = tok.endsWith('s') ? tok.slice(0, -1) : tok;
    const re = new RegExp(`(?<![a-z0-9])${stem}s?(?![a-z0-9])`, 'i');
    if (re.test(title)) return false;
  }

  // Reject if any known explicit giveaway term appears in the title.
  const giveaways = [
    ...(SUBREDDIT_GIVEAWAYS[post.subreddit] ?? []),
    ...(SUBREDDIT_GIVEAWAYS[sub]             ?? []),
  ];
  for (const term of giveaways) {
    const re = new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i');
    if (re.test(title)) return false;
  }

  return true;
}

function extractImages(post) {
  // RSS-sourced posts carry pre-extracted image URLs
  if (post._images) return post._images.length ? post._images : null;
  return null;
}

// ── RSS helpers ───────────────────────────────────────────────────────────────
// Reddit's public RSS/Atom feeds work from any IP with no credentials.
// JSON API now returns 403 universally for unauthenticated cloud requests.

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

// Parse Atom entries from a Reddit RSS response into post-shaped objects.
function parseRSSEntries(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const title     = decodeHtml(e.match(/<title>([^<]*)<\/title>/)?.[1] ?? '');
    const permalink = e.match(/<link[^>]+href="([^"]+)"/)?.[1] ?? '';
    const subreddit = e.match(/<category term="([^"]+)"/)?.[1] ?? '';
    const author    = e.match(/<name>\/u\/([^<]+)<\/name>/)?.[1] ?? '';
    const content   = e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? '';

    // Try to extract a direct i.redd.it image link first (no signature needed,
    // full resolution). Falls back to the RSS preview thumbnail if not found.
    // RSS double-encodes ampersands (&amp;amp;), so we double-decode those.
    const directLink = content.match(/&lt;a href=&quot;(https:\/\/i\.redd\.it\/[^&"]+)&quot;&gt;\[link\]/)?.[1];
    const images = directLink
      ? [decodeHtml(directLink)]
      : [...content.matchAll(/&lt;img src=&quot;(https:\/\/(?:(?!&quot;).)+)&quot;/g)]
          .map(m => decodeHtml(decodeHtml(m[1])))
          .filter(url => url.startsWith('https://'));

    return {
      title,
      subreddit,
      permalink,
      // Normalise to the shape isEligible() expects:
      over_18:  false,
      stickied: /mod|automod/i.test(author),
      spoiler:  false,
      score:    100,  // assume hot-listed posts meet the quality bar
      url:      permalink,
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
    const posts = parseRSSEntries(xml);
    return posts.find(p => p.subreddit && isEligible(p)) ?? null;
  } catch (err) {
    console.error(`fetchHotPost(${subreddit}):`, err.message);
    return null;
  }
}

async function searchForPost(keyword, usedSubs, rng) {
  try {
    const xml   = await redditRSS(`https://www.reddit.com/search.rss?q=${encodeURIComponent(keyword)}&sort=relevance&t=week`);
    const posts = parseRSSEntries(xml);
    const eligible = posts.filter(p => p.subreddit && !usedSubs.has(p.subreddit.toLowerCase()) && isEligible(p));
    if (!eligible.length) return null;
    return eligible[Math.floor(rng() * Math.min(eligible.length, 5))];
  } catch (err) {
    console.error(`searchForPost(${keyword}):`, err.message);
    return null;
  }
}

// ── Similarity-based unified selection ───────────────────────────────────────
// Fetches up to 100 posts matching `keyword`, then greedily picks the 5 that
// are most lexically confusable with each other (and with the seed post) using
// Jaccard similarity on keyword sets.
//
// Selection thresholds:
//   sim < MIN_SIM  → unrelated post, skip (would make the puzzle too easy)
//   sim > REPOST   → near-repost of the seed, skip (would make it trivially hard)
//   Otherwise      → greedy-pick to maximise average pairwise similarity
//
// Using t=month (instead of t=week) to widen the candidate pool.
async function tryUnifiedWithSimilarity(keyword, seedRound, seed) {
  try {
    const xml   = await redditRSS(`https://www.reddit.com/search.rss?q=${encodeURIComponent(keyword)}&sort=relevance&t=month`);
    const posts = parseRSSEntries(xml);

    // One eligible post per subreddit (exclude seed sub).
    // Also deduplicate by normalised title to filter out cross-posts —
    // two rounds with the same text would immediately reveal themselves.
    const seedSub = seedRound.subreddit.toLowerCase();
    const bySubreddit = new Map();
    const seenTitles  = new Set([cleanTitle(seedRound.post_title).toLowerCase()]);
    for (const p of posts) {
      const sub          = p.subreddit.toLowerCase();
      const titleNorm    = cleanTitle(p.title).toLowerCase();
      if (sub === seedSub || !isEligible(p)) continue;
      if (seenTitles.has(titleNorm)) continue;   // cross-post — skip
      if (!bySubreddit.has(sub)) {
        bySubreddit.set(sub, p);
        seenTitles.add(titleNorm);
      }
    }
    const candidates = [...bySubreddit.values()];

    if (candidates.length < 5) {
      console.error(`[sim] "${keyword}": only ${candidates.length} unique subreddits — need 5+`);
      return null;
    }

    // Precompute keyword sets for seed + all candidates
    const seedKws = new Set(extractKeywords(seedRound.post_title));

    const REPOST_THRESHOLD = 0.65; // above this → near-repost of seed
    const MIN_SIM          = 0.05; // below this → completely unrelated

    const pool = candidates
      .map(p => ({ post: p, kws: new Set(extractKeywords(cleanTitle(p.title))) }))
      .filter(({ kws }) => {
        const sim = jaccard(seedKws, kws);
        return sim >= MIN_SIM && sim <= REPOST_THRESHOLD;
      });

    if (pool.length < 5) {
      console.error(`[sim] "${keyword}": only ${pool.length} candidates after similarity filter`);
      return null;
    }

    // ── Greedy maximisation of average pairwise Jaccard ───────────────────────
    // At each step: pick the available candidate whose keyword set has the
    // highest average Jaccard to all already-selected posts (seed included).
    // This approximates the maximum-weight dense subgraph without brute-force.
    const selected = [{ post: null, kws: seedKws }]; // seed is the anchor
    const available = [...pool];

    while (selected.length < 6 && available.length > 0) {
      let bestScore = -1;
      let bestIdx   = 0;

      for (let i = 0; i < available.length; i++) {
        const { kws } = available[i];
        const avgSim = selected.reduce((s, sel) => s + jaccard(kws, sel.kws), 0) / selected.length;
        if (avgSim > bestScore) { bestScore = avgSim; bestIdx = i; }
      }

      const chosen = available.splice(bestIdx, 1)[0];
      selected.push(chosen);
      console.error(
        `[sim]   +r/${chosen.post.subreddit} avgSim=${bestScore.toFixed(3)}` +
        ` — "${chosen.post.title.slice(0, 55)}"`
      );
    }

    if (selected.length < 6) return null;

    // Build round objects (skip the seed anchor at index 0)
    const rounds = [seedRound];
    for (const { post } of selected.slice(1)) {
      rounds.push({
        subreddit:       post.subreddit,
        post_title:      cleanTitle(post.title),
        post_url:        post.permalink,
        post_score:      post.score,
        post_images:     extractImages(post),
        linking_keyword: keyword,
      });
    }

    return rounds;
  } catch (err) {
    console.error(`tryUnifiedWithSimilarity(${keyword}):`, err.message);
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
      post_url: post.permalink,
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
    console.error(`[sim] trying unified keyword "${keyword}"`);
    await sleep(300);
    const attempt = await tryUnifiedWithSimilarity(keyword, rounds[0], seed);
    if (attempt) {
      console.error(`[sim] success with "${keyword}"`);
      unifiedResult = { rounds: attempt, unified_keyword: keyword };
      break;
    }
    console.error(`[sim] failed with "${keyword}"`);
  }

  if (unifiedResult) {
    const shuffled_options = seededShuffle(unifiedResult.rounds.map(r => r.subreddit), seed + 7919);
    return {
      date,
      puzzle_type: 'similarity',   // unified keyword + Jaccard-greedy selection
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
      post_url: post.permalink,
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
        post_url: post.permalink,
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
