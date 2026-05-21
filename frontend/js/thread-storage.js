// localStorage state for Find the Thread game.

const ThreadStorage = (() => {
  const GAME_KEY  = date => `ftt_game_${date}`;
  const STATS_KEY = 'ftt_stats';

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

  function initGame(date) {
    return {
      date,
      status: 'playing',
      strikes: 0,
      max_strikes: 3,
      found_groups: [],  // [{ post_index, subreddit, post_title, post_url, post_images }]
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

  function clearGame(date) {
    localStorage.removeItem(GAME_KEY(date));
  }

  return { getStats, getGame, saveGame, initGame, updateStatsAfterGame, clearGame };
})();
