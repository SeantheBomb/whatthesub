const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function today() { return new Date().toISOString().slice(0, 10); }

// ── Crypto helpers ────────────────────────────────────────────────────────────
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signJWT(payload, secret) {
  const enc = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
  const body = btoa(JSON.stringify(payload)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
  const msg = `${header}.${body}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
  return `${msg}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const msg = `${header}.${body}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(msg));
    if (!valid) return null;
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  return verifyJWT(token, env.JWT_SECRET);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const { pathname, searchParams } = new URL(request.url);

    // ── GET /api/puzzle/today ──────────────────────────────────────────────────
    if (pathname === '/api/puzzle/today' && request.method === 'GET') {
      const date = searchParams.get('date') || today();
      const raw = await env.PUZZLES.get(`puzzle:${date}`);
      if (!raw) return json({ error: 'No puzzle available yet.' }, 404);
      const puzzle = JSON.parse(raw);
      return json({
        date: puzzle.date,
        puzzle_type: puzzle.puzzle_type ?? 'chained',
        rounds: puzzle.rounds.map((r, i) => ({
          id: i,
          post_title: r.post_title,
          post_url: r.post_url,
          post_images: r.post_images ?? (r.post_image ? [r.post_image] : null),
        })),
        options: puzzle.shuffled_options,
      });
    }

    // ── POST /api/puzzle/guess ─────────────────────────────────────────────────
    if (pathname === '/api/puzzle/guess' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { date, round, guess } = body ?? {};
      if (!date || round == null || !guess) return json({ error: 'Required: date, round, guess' }, 400);
      const raw = await env.PUZZLES.get(`puzzle:${date}`);
      if (!raw) return json({ error: 'Puzzle not found' }, 404);
      const puzzle = JSON.parse(raw);
      if (round < 0 || round >= puzzle.rounds.length) return json({ error: 'Round out of range' }, 400);
      const correct = puzzle.rounds[round].subreddit === guess;
      return json({ correct, ...(correct ? { subreddit: guess } : {}) });
    }

    // ── GET /api/puzzle/reveal ─────────────────────────────────────────────────
    if (pathname === '/api/puzzle/reveal' && request.method === 'GET') {
      const date = searchParams.get('date') || today();
      const raw = await env.PUZZLES.get(`puzzle:${date}`);
      if (!raw) return json({ error: 'Puzzle not found' }, 404);
      const { rounds, unified_keyword, puzzle_type } = JSON.parse(raw);
      return json({
        date,
        puzzle_type: puzzle_type ?? 'chained',
        unified_keyword: unified_keyword ?? null,
        answers: rounds.map((r, i) => ({
          round: i,
          subreddit: r.subreddit,
          post_url: r.post_url,
          linking_keyword: r.linking_keyword ?? null,
        })),
      });
    }

    // ── POST /api/auth/register ────────────────────────────────────────────────
    if (pathname === '/api/auth/register' && request.method === 'POST') {
      if (!env.DB) return json({ error: 'Database not configured' }, 503);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { username, email, password } = body ?? {};
      if (!username || !email || !password) return json({ error: 'Required: username, email, password' }, 400);
      if (username.length < 3 || username.length > 20) return json({ error: 'Username must be 3–20 chars' }, 400);
      if (!/^[a-zA-Z0-9_]+$/.test(username)) return json({ error: 'Username: letters, numbers, underscores only' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 chars' }, 400);

      const salt = randomSalt();
      const hash = await hashPassword(password, salt);
      const id = crypto.randomUUID();

      try {
        await env.DB.prepare(
          'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)'
        ).bind(id, username.toLowerCase(), email.toLowerCase(), `${salt}:${hash}`).run();
      } catch (e) {
        if (e.message?.includes('UNIQUE')) return json({ error: 'Username or email already taken' }, 409);
        throw e;
      }

      const token = await signJWT({ sub: id, username: username.toLowerCase(), exp: Math.floor(Date.now() / 1000) + 86400 * 30 }, env.JWT_SECRET);
      return json({ token, user: { id, username: username.toLowerCase(), is_admin: false, unlimited_play: false } }, 201);
    }

    // ── POST /api/auth/login ───────────────────────────────────────────────────
    if (pathname === '/api/auth/login' && request.method === 'POST') {
      if (!env.DB) return json({ error: 'Database not configured' }, 503);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { username, password } = body ?? {};
      if (!username || !password) return json({ error: 'Required: username, password' }, 400);

      const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username.toLowerCase()).first();
      if (!row) return json({ error: 'Invalid username or password' }, 401);

      const [salt, hash] = row.password_hash.split(':');
      const attempt = await hashPassword(password, salt);
      if (attempt !== hash) return json({ error: 'Invalid username or password' }, 401);

      const token = await signJWT({ sub: row.id, username: row.username, exp: Math.floor(Date.now() / 1000) + 86400 * 30 }, env.JWT_SECRET);
      return json({ token, user: { id: row.id, username: row.username, is_admin: !!row.is_admin, unlimited_play: !!row.unlimited_play } });
    }

    // ── GET /api/auth/me ───────────────────────────────────────────────────────
    if (pathname === '/api/auth/me' && request.method === 'GET') {
      const payload = await requireAuth(request, env);
      if (!payload) return json({ error: 'Unauthorized' }, 401);
      if (!env.DB) return json({ error: 'Database not configured' }, 503);
      const row = await env.DB.prepare('SELECT id, username, is_admin, unlimited_play FROM users WHERE id = ?').bind(payload.sub).first();
      if (!row) return json({ error: 'User not found' }, 404);
      return json({ id: row.id, username: row.username, is_admin: !!row.is_admin, unlimited_play: !!row.unlimited_play });
    }

    // ── POST /api/game/result ──────────────────────────────────────────────────
    if (pathname === '/api/game/result' && request.method === 'POST') {
      const payload = await requireAuth(request, env);
      if (!payload) return json({ error: 'Unauthorized' }, 401);
      if (!env.DB) return json({ error: 'Database not configured' }, 503);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { date, status, strikes, rounds_won, duration_sec } = body ?? {};
      if (!date || !status) return json({ error: 'Required: date, status' }, 400);

      const id = crypto.randomUUID();
      try {
        await env.DB.prepare(
          'INSERT INTO game_results (id, user_id, puzzle_date, status, strikes, rounds_won, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, payload.sub, date, status, strikes ?? 0, rounds_won ?? 0, duration_sec ?? null).run();
      } catch (e) {
        if (e.message?.includes('UNIQUE')) return json({ ok: true, already_recorded: true });
        throw e;
      }

      return json({ ok: true, id }, 201);
    }

    // ── GET /api/user/stats ────────────────────────────────────────────────────
    if (pathname === '/api/user/stats' && request.method === 'GET') {
      const payload = await requireAuth(request, env);
      if (!payload) return json({ error: 'Unauthorized' }, 401);
      if (!env.DB) return json({ error: 'Database not configured' }, 503);

      const stats = await env.DB.prepare(`
        SELECT
          COUNT(*) as games_played,
          SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) as games_won,
          AVG(CASE WHEN status='won' THEN strikes ELSE NULL END) as avg_strikes
        FROM game_results WHERE user_id = ?
      `).bind(payload.sub).first();

      return json({
        games_played: stats.games_played ?? 0,
        games_won: stats.games_won ?? 0,
        avg_strikes: stats.avg_strikes != null ? Math.round(stats.avg_strikes * 10) / 10 : null,
      });
    }

    // ── GET /api/leaderboard/daily ─────────────────────────────────────────────
    if (pathname === '/api/leaderboard/daily' && request.method === 'GET') {
      if (env.DB) {
        const date = searchParams.get('date') || today();
        const rows = await env.DB.prepare(`
          SELECT u.username, g.strikes, g.duration_sec, g.rounds_won
          FROM game_results g JOIN users u ON g.user_id = u.id
          WHERE g.puzzle_date = ? AND g.status = 'won'
          ORDER BY g.strikes ASC, g.duration_sec ASC NULLS LAST
          LIMIT 20
        `).bind(date).all();
        return json({ date, entries: rows.results ?? [] });
      }
      return json({ date: today(), entries: [] });
    }

    // ── GET /api/leaderboard/alltime ───────────────────────────────────────────
    if (pathname === '/api/leaderboard/alltime' && request.method === 'GET') {
      if (env.DB) {
        const rows = await env.DB.prepare(`
          SELECT u.username, COUNT(*) as wins,
                 AVG(g.strikes) as avg_strikes,
                 MIN(g.strikes) as best_strikes
          FROM game_results g JOIN users u ON g.user_id = u.id
          WHERE g.status = 'won'
          GROUP BY g.user_id, u.username
          ORDER BY wins DESC, avg_strikes ASC
          LIMIT 20
        `).all();
        return json({ entries: rows.results ?? [] });
      }
      return json({ entries: [] });
    }

    // ── GET /api/thread/today ──────────────────────────────────────────────────
    if (pathname === '/api/thread/today' && request.method === 'GET') {
      const date = searchParams.get('date') || today();
      const raw = await env.PUZZLES.get(`thread:${date}`);
      if (!raw) return json({ error: 'No thread puzzle available yet.' }, 404);
      const puzzle = JSON.parse(raw);
      // Strip post_index from shuffled_comments before sending to client
      return json({
        date: puzzle.date,
        comments: puzzle.shuffled_comments.map(c => ({
          id: c.id,
          body: c.body,
          score: c.score,
        })),
      });
    }

    // ── POST /api/thread/guess ─────────────────────────────────────────────────
    if (pathname === '/api/thread/guess' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { date, group } = body ?? {};
      if (!date || !Array.isArray(group) || group.length !== 4) {
        return json({ error: 'Required: date, group (array of 4 comment IDs)' }, 400);
      }
      const raw = await env.PUZZLES.get(`thread:${date}`);
      if (!raw) return json({ error: 'Puzzle not found' }, 404);
      const puzzle = JSON.parse(raw);

      // Build id → post_index map
      const idToPostIndex = new Map();
      for (const c of puzzle.shuffled_comments) {
        idToPostIndex.set(c.id, c.post_index);
      }

      const indices = group.map(id => idToPostIndex.get(id));
      if (indices.some(i => i == null)) return json({ error: 'Unknown comment ID' }, 400);

      const allSame = indices.every(i => i === indices[0]);
      if (!allSame) {
        // Check if exactly 3 of the 4 share the same post_index ("one away")
        const counts = {};
        for (const idx of indices) counts[idx] = (counts[idx] ?? 0) + 1;
        const oneAway = Object.values(counts).some(c => c === 3);
        return json({ correct: false, one_away: oneAway });
      }

      const post_index = indices[0];
      const round = puzzle.rounds[post_index];
      return json({
        correct: true,
        post_index,
        subreddit: round.subreddit,
        post_title: round.post_title,
        post_url: round.post_url,
        post_images: round.post_images ?? null,
      });
    }

    // ── GET /api/thread/reveal ─────────────────────────────────────────────────
    if (pathname === '/api/thread/reveal' && request.method === 'GET') {
      const date = searchParams.get('date') || today();
      const raw = await env.PUZZLES.get(`thread:${date}`);
      if (!raw) return json({ error: 'Puzzle not found' }, 404);
      const puzzle = JSON.parse(raw);
      return json({
        date: puzzle.date,
        rounds: puzzle.rounds.map((r, i) => ({
          post_index: i,
          subreddit: r.subreddit,
          post_title: r.post_title,
          post_url: r.post_url,
          post_images: r.post_images ?? null,
          comment_ids: r.comments.map(c => c.id),
        })),
      });
    }

    // ── POST /api/thread/result ────────────────────────────────────────────────
    if (pathname === '/api/thread/result' && request.method === 'POST') {
      const payload = await requireAuth(request, env);
      if (!payload) return json({ error: 'Unauthorized' }, 401);
      if (!env.DB) return json({ error: 'Database not configured' }, 503);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const { date, status, strikes, groups_found, duration_sec } = body ?? {};
      if (!date || !status) return json({ error: 'Required: date, status' }, 400);

      const id = crypto.randomUUID();
      try {
        await env.DB.prepare(
          'INSERT INTO thread_results (id, user_id, puzzle_date, status, strikes, groups_found, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, payload.sub, date, status, strikes ?? 0, groups_found ?? 0, duration_sec ?? null).run();
      } catch (e) {
        if (e.message?.includes('UNIQUE')) return json({ ok: true, already_recorded: true });
        throw e;
      }
      return json({ ok: true, id }, 201);
    }

    // ── GET /api/user/thread-stats ─────────────────────────────────────────────
    if (pathname === '/api/user/thread-stats' && request.method === 'GET') {
      const payload = await requireAuth(request, env);
      if (!payload) return json({ error: 'Unauthorized' }, 401);
      if (!env.DB) return json({ error: 'Database not configured' }, 503);

      const stats = await env.DB.prepare(`
        SELECT
          COUNT(*) as games_played,
          SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) as games_won,
          AVG(CASE WHEN status='won' THEN strikes ELSE NULL END) as avg_strikes
        FROM thread_results WHERE user_id = ?
      `).bind(payload.sub).first();

      return json({
        games_played: stats.games_played ?? 0,
        games_won: stats.games_won ?? 0,
        avg_strikes: stats.avg_strikes != null ? Math.round(stats.avg_strikes * 10) / 10 : null,
      });
    }

    // ── GET /api/leaderboard/thread/daily ─────────────────────────────────────
    if (pathname === '/api/leaderboard/thread/daily' && request.method === 'GET') {
      if (env.DB) {
        const date = searchParams.get('date') || today();
        const rows = await env.DB.prepare(`
          SELECT u.username, t.strikes, t.duration_sec, t.groups_found
          FROM thread_results t JOIN users u ON t.user_id = u.id
          WHERE t.puzzle_date = ? AND t.status = 'won'
          ORDER BY t.strikes ASC, t.duration_sec ASC NULLS LAST
          LIMIT 20
        `).bind(date).all();
        return json({ date, entries: rows.results ?? [] });
      }
      return json({ date: today(), entries: [] });
    }

    // ── GET /api/leaderboard/thread/alltime ───────────────────────────────────
    if (pathname === '/api/leaderboard/thread/alltime' && request.method === 'GET') {
      if (env.DB) {
        const rows = await env.DB.prepare(`
          SELECT u.username, COUNT(*) as wins,
                 AVG(t.strikes) as avg_strikes,
                 MIN(t.strikes) as best_strikes
          FROM thread_results t JOIN users u ON t.user_id = u.id
          WHERE t.status = 'won'
          GROUP BY t.user_id, u.username
          ORDER BY wins DESC, avg_strikes ASC
          LIMIT 20
        `).all();
        return json({ entries: rows.results ?? [] });
      }
      return json({ entries: [] });
    }

    // ── GET /api/health ────────────────────────────────────────────────────────
    if (pathname === '/api/health') return json({ ok: true, date: today() });

    return json({ error: 'Not found' }, 404);
  },
};
