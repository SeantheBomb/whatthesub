// HTTP layer — all calls to the API worker go through here.

const API = (() => {
  function base() {
    return (typeof CONFIG !== 'undefined' && CONFIG.API_BASE) || '';
  }

  async function get(path) {
    const res = await fetch(base() + path);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function post(path, data) {
    const res = await fetch(base() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function fetchPuzzle(date) {
    const qs = date ? `?date=${date}` : '';
    return get(`/api/puzzle/today${qs}`);
  }

  function submitGuess(date, round, guess) {
    return post('/api/puzzle/guess', { date, round, guess });
  }

  function revealAnswers(date) {
    return get(`/api/puzzle/reveal?date=${encodeURIComponent(date)}`);
  }

  function fetchLeaderboard(type = 'daily') {
    return get(`/api/leaderboard/${type}`);
  }

  async function saveResult(date, status, strikes, rounds_won, duration_sec) {
    const token = typeof Auth !== 'undefined' ? Auth.getToken() : null;
    if (!token) return;
    return fetch(base() + '/api/game/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ date, status, strikes, rounds_won, duration_sec }),
    });
  }

  // ── Find the Thread ──────────────────────────────────────────────────────────

  function fetchThread(date) {
    const qs = date ? `?date=${date}` : '';
    return get(`/api/thread/today${qs}`);
  }

  function submitThreadGuess(date, group) {
    return post('/api/thread/guess', { date, group });
  }

  function revealThread(date) {
    return get(`/api/thread/reveal?date=${encodeURIComponent(date)}`);
  }

  async function saveThreadResult(date, status, strikes, groups_found, duration_sec) {
    const token = typeof Auth !== 'undefined' ? Auth.getToken() : null;
    if (!token) return;
    return fetch(base() + '/api/thread/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ date, status, strikes, groups_found, duration_sec }),
    });
  }

  return { fetchPuzzle, submitGuess, revealAnswers, fetchLeaderboard, saveResult,
           fetchThread, submitThreadGuess, revealThread, saveThreadResult };
})();
