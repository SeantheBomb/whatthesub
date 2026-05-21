// All localStorage interactions for WhatTheSub guest state.

const Storage = (() => {
  const GAME_KEY = date => `wts_game_${date}`;
  const STATS_KEY = 'wts_stats';

  function getStats() {
    try {
      return JSON.parse(localStorage.getItem(STATS_KEY)) ?? defaultStats();
    } catch {
      return defaultStats();
    }
  }

  function defaultStats() {
    return { games_played: 0, games_won: 0, current_streak: 0, max_streak: 0, last_played: null };
  }

  function saveStats(stats) {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  }

  function getGame(date) {
    try {
      return JSON.parse(localStorage.getItem(GAME_KEY(date)));
    } catch {
      return null;
    }
  }

  function saveGame(date, state) {
    localStorage.setItem(GAME_KEY(date), JSON.stringify(state));
  }

  function initGame(date, puzzle) {
    return {
      date,
      status: 'playing',
      strikes: 0,
      max_strikes: 3,
      current_round: 0,
      rounds: puzzle.rounds.map(r => ({
        id: r.id,
        status: 'pending',   // 'pending' | 'correct' | 'skipped'
        guesses: [],          // wrong guesses for this specific round
        correct_subreddit: null,
      })),
      remaining_options: [...puzzle.options],
      started_at: new Date().toISOString(),
      completed_at: null,
    };
  }

  function updateStatsAfterGame(game) {
    const stats = getStats();
    stats.games_played += 1;

    if (game.status === 'won') {
      stats.games_won += 1;
      const lastDate = stats.last_played ? new Date(stats.last_played) : null;
      const today = new Date(game.date);
      const gapDays = lastDate
        ? Math.round((today - lastDate) / 86400000)
        : null;

      stats.current_streak = gapDays === 1 ? stats.current_streak + 1 : 1;
      if (stats.current_streak > stats.max_streak) {
        stats.max_streak = stats.current_streak;
      }
    } else {
      stats.current_streak = 0;
    }

    stats.last_played = game.date;
    saveStats(stats);
  }

  function getGameHistory() {
    const history = [];
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('wts_game_')) continue;
      try {
        const game = JSON.parse(localStorage.getItem(key));
        if (game?.status && game.status !== 'playing') history.push(game);
      } catch { /* skip corrupted entries */ }
    }
    return history.sort((a, b) => b.date.localeCompare(a.date));
  }

  return { getStats, saveStats, getGame, saveGame, initGame, updateStatsAfterGame, getGameHistory };
})();
