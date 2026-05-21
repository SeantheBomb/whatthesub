const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const { pathname, searchParams } = new URL(request.url);

    // GET /api/puzzle/today
    if (pathname === '/api/puzzle/today' && request.method === 'GET') {
      const date = searchParams.get('date') || today();
      const raw = await env.PUZZLES.get(`puzzle:${date}`);
      if (!raw) {
        return json({
          error: 'No puzzle available yet. The daily worker runs at 00:05 UTC — or POST /generate on the daily worker to seed manually.',
        }, 404);
      }
      const puzzle = JSON.parse(raw);
      return json({
        date: puzzle.date,
        rounds: puzzle.rounds.map((r, i) => ({
          id: i,
          post_title: r.post_title,
          post_url: r.post_url,
        })),
        options: puzzle.shuffled_options,
      });
    }

    // POST /api/puzzle/guess
    if (pathname === '/api/puzzle/guess' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const { date, round, guess } = body ?? {};
      if (!date || round == null || !guess) {
        return json({ error: 'Required fields: date (string), round (number), guess (string)' }, 400);
      }
      const raw = await env.PUZZLES.get(`puzzle:${date}`);
      if (!raw) return json({ error: 'Puzzle not found for this date' }, 404);

      const puzzle = JSON.parse(raw);
      if (round < 0 || round >= puzzle.rounds.length) {
        return json({ error: 'Round index out of range' }, 400);
      }
      const correct = puzzle.rounds[round].subreddit === guess;
      // Only reveal the subreddit on a correct guess — never expose answers proactively
      return json({ correct, ...(correct ? { subreddit: guess } : {}) });
    }

    // GET /api/puzzle/reveal — called post-game to show answers
    if (pathname === '/api/puzzle/reveal' && request.method === 'GET') {
      const date = searchParams.get('date') || today();
      const raw = await env.PUZZLES.get(`puzzle:${date}`);
      if (!raw) return json({ error: 'Puzzle not found' }, 404);
      const { rounds } = JSON.parse(raw);
      return json({
        date,
        answers: rounds.map((r, i) => ({
          round: i,
          subreddit: r.subreddit,
          post_url: r.post_url,
        })),
      });
    }

    // GET /api/leaderboard/daily — Phase 1 stub
    if (pathname === '/api/leaderboard/daily' && request.method === 'GET') {
      return json({ date: today(), entries: [] });
    }

    // GET /api/leaderboard/alltime — Phase 1 stub
    if (pathname === '/api/leaderboard/alltime' && request.method === 'GET') {
      return json({ entries: [] });
    }

    // GET /api/health
    if (pathname === '/api/health') {
      return json({ ok: true, date: today() });
    }

    return json({ error: 'Not found' }, 404);
  },
};
