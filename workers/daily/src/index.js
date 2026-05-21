// Default subreddit pool — admin-modifiable via KV key "config:subreddit_pool"
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

// Mulberry32 — fast, seedable PRNG
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

async function fetchHotPost(subreddit) {
  const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=15&raw_json=1`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'WhatTheSub/1.0 daily-puzzle-game (contact: github.com/SeantheBomb/whatthesub)' },
    });
    if (!res.ok) {
      console.error(`Reddit ${res.status} for r/${subreddit}`);
      return null;
    }
    const data = await res.json();
    const posts = (data?.data?.children ?? []).map(p => p.data);
    const eligible = posts.filter(p =>
      !p.stickied &&
      !p.over_18 &&
      !p.spoiler &&
      p.title?.length >= 20 &&
      p.title?.length <= 280 &&
      p.score > 50
    );
    return eligible[0] ?? null;
  } catch (err) {
    console.error(`Fetch failed for r/${subreddit}:`, err.message);
    return null;
  }
}

async function generatePuzzle(date, env) {
  const seed = dateToSeed(date);

  // Admin-configurable pool stored in KV as JSON array
  let pool = DEFAULT_POOL;
  const customPool = await env.PUZZLES.get('config:subreddit_pool');
  if (customPool) {
    try { pool = JSON.parse(customPool); } catch { /* fall through to default */ }
  }

  const shuffled = seededShuffle(pool, seed);
  const rounds = [];

  for (const subreddit of shuffled) {
    if (rounds.length >= 6) break;
    const post = await fetchHotPost(subreddit);
    if (!post) {
      console.warn(`No eligible post for r/${subreddit}, skipping`);
      continue;
    }
    rounds.push({
      subreddit,
      post_title: post.title,
      post_url: `https://reddit.com${post.permalink}`,
      post_score: post.score,
    });
  }

  if (rounds.length < 6) {
    throw new Error(`Only got ${rounds.length}/6 rounds for ${date}`);
  }

  // Shuffle the options display order independently (prime offset keeps it uncorrelated)
  const shuffled_options = seededShuffle(rounds.map(r => r.subreddit), seed + 7919);

  return { date, rounds, shuffled_options, generated_at: new Date().toISOString() };
}

export default {
  async scheduled(event, env) {
    const date = new Date().toISOString().slice(0, 10);
    console.log(`[WhatTheSub] Generating puzzle for ${date}`);
    try {
      const puzzle = await generatePuzzle(date, env);
      await env.PUZZLES.put(`puzzle:${date}`, JSON.stringify(puzzle), { expirationTtl: 90000 });
      console.log(`[WhatTheSub] Puzzle stored — ${puzzle.rounds.length} rounds`);
    } catch (err) {
      console.error(`[WhatTheSub] Generation failed:`, err.message);
    }
  },

  // HTTP handler lets you trigger generation manually for testing:
  // POST /generate?date=2026-05-20
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    if (pathname === '/generate' && request.method === 'POST') {
      const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);
      try {
        const puzzle = await generatePuzzle(date, env);
        await env.PUZZLES.put(`puzzle:${date}`, JSON.stringify(puzzle), { expirationTtl: 90000 });
        return Response.json({ ok: true, date, rounds: puzzle.rounds.length });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    return new Response('WhatTheSub Daily Worker — POST /generate?date=YYYY-MM-DD to trigger', { status: 200 });
  },
};
