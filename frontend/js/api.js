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

  return { fetchPuzzle, submitGuess, revealAnswers, fetchLeaderboard };
})();
