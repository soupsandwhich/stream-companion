/**
 * Stream Companion - chat games (trivia + guess-the-movie) and the
 * cumulative game leaderboard.
 *
 * Ported in 1.4.0 from the old standalone server (src/server/index.js), where
 * this logic lived and was unreachable in sync mode. Behaviour, routes, data
 * formats and WebSocket message types are kept the same so the renderer and
 * the trivia.html / movies.html overlays work unchanged.
 *
 * The games never post to Twitch chat (neither did the standalone server), so
 * nothing here needs Twitch tokens. Chat answers arrive from Tower through
 * the sync client and are fed in via handleChatMessage().
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const IMAGE_RE = /\.(jpg|jpeg|png|gif|webp)$/i;
const DEFAULT_PLACEMENT = { first: 3, second: 2, third: 1 };

function freshGameStats(placementPoints) {
  return {
    players: {},
    placementPoints: placementPoints || { ...DEFAULT_PLACEMENT },
    history: [],
    periodStart: new Date().toISOString()
  };
}

// ---------- Persistent store (companion.json, gameStats key only) ----------
// The standalone server kept its whole DB in companion.json; we keep using the
// same file so existing leaderboards carry over, and preserve any other keys.
class GameStatsStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'companion.json');
    this.data = {};
    this.writable = true;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
      }
      console.log(`[Games] Game stats file: ${this.file}`);
    } catch (e) {
      console.error(`[Games] Could not load game stats from ${this.file}: ${e.message}. Stats will be kept in memory only until this is fixed.`);
      this.writable = !fs.existsSync(this.file); // never overwrite a file we failed to parse
    }
    if (!this.data.gameStats) this.data.gameStats = freshGameStats();
    const gs = this.data.gameStats;
    gs.players = gs.players || {};
    gs.history = gs.history || [];
    gs.placementPoints = gs.placementPoints || { ...DEFAULT_PLACEMENT };
  }

  get stats() { return this.data.gameStats; }
  set stats(v) { this.data.gameStats = v; }

  save() {
    if (!this.writable) {
      console.error('[Games] Not saving game stats: existing companion.json could not be read');
      return;
    }
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error(`[Games] Error saving game stats to ${this.file}: ${e.message}`);
    }
  }
}

function sortedLeaderboard(players) {
  return Object.entries(players)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.points - a.points);
}

function generateTileRevealOrder(totalTiles = 40) {
  const indices = Array.from({ length: totalTiles }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

function createGames({ broadcast, triviaDir, moviesDir, dataDir }) {
  const store = new GameStatsStore(dataDir);
  let nextId = Date.now();
  const newId = () => ++nextId;

  // ---------- Startup check of data folders ----------
  function checkDir(label, dir) {
    if (!fs.existsSync(dir)) {
      console.error(`[Games] ${label} folder not found: ${dir} - ${label.toLowerCase()} games will not start until it exists`);
      return false;
    }
    console.log(`[Games] ${label} folder: ${dir}`);
    return true;
  }
  checkDir('Trivia', triviaDir);
  checkDir('Movies', moviesDir);

  function missingDir(res, label, dir) {
    const msg = `${label} folder not found: ${dir}`;
    console.error(`[Games] ${msg}`);
    res.status(400).json({ success: false, error: msg });
  }

  // ---------- State ----------
  let triviaState = {
    active: false, currentQuestion: null, answersRevealed: [], players: {},
    questionCount: 0, maxQuestions: 5
  };
  let triviaChatBuffer = [];

  let revealInterval = null; // kept out of movieState so state stays JSON-serialisable
  let movieState = {
    active: false, currentMovie: null, revealLevel: 0, answered: false, answeredBy: null,
    players: {}, movieCount: 0, maxMovies: 5, usedMovies: [], availableMovies: [],
    pointsPerMovie: 500, totalGameTime: 180, timePerMovie: 36, movieStartTime: null,
    timeRemaining: 0, tileRevealOrder: []
  };
  let movieChatBuffer = [];

  function stopReveal() {
    if (revealInterval) {
      clearInterval(revealInterval);
      revealInterval = null;
    }
  }

  function pushCapped(buffer, msg) {
    buffer.push(msg);
    return buffer.length > 100 ? buffer.slice(-100) : buffer;
  }

  // Streamerbot may still POST the same chat line to check-answer while the
  // Tower feed delivers it too; ignore an identical line from the same user
  // seen in the last few seconds.
  function isDuplicate(buffer, user, message) {
    const cutoff = Date.now() - 5000;
    return buffer.some(m => m.user === user && m.message === message && Date.parse(m.timestamp) >= cutoff);
  }

  // ---------- Placement points (shared by trivia + movies) ----------
  function recordGameResult(leaderboard, historyEntry) {
    const gs = store.stats;
    const placement = gs.placementPoints;
    const now = new Date().toISOString();

    leaderboard.forEach((player, index) => {
      if (!gs.players[player.name]) {
        gs.players[player.name] = {
          totalPoints: 0, wins: 0, secondPlace: 0, thirdPlace: 0, gamesPlayed: 0, lastPlayed: null
        };
      }
      const stats = gs.players[player.name];
      stats.gamesPlayed++;
      stats.lastPlayed = now;
      if (index === 0) { stats.wins++; stats.totalPoints += placement.first; }
      else if (index === 1) { stats.secondPlace++; stats.totalPoints += placement.second; }
      else if (index === 2) { stats.thirdPlace++; stats.totalPoints += placement.third; }
    });

    gs.history.push({
      date: now,
      ...historyEntry,
      leaderboard: leaderboard.slice(0, 10).map(p => ({
        name: p.name, points: p.points, correctAnswers: p.correctAnswers
      }))
    });
    if (gs.history.length > 100) gs.history = gs.history.slice(-100);
    store.save();
  }

  // ---------- Trivia answer handling ----------
  function submitTriviaAnswer(user, answer, autoMatch = true) {
    if (!triviaState.active || !triviaState.currentQuestion) return { correct: false };
    const text = String(answer || '').trim();
    if (!text || !user) return { correct: false };
    if (isDuplicate(triviaChatBuffer, user, text)) return { correct: false, duplicate: true };

    const chatMsg = {
      id: newId(), user, message: text, timestamp: new Date().toISOString(),
      processed: false, matchedAnswer: null
    };
    triviaChatBuffer = pushCapped(triviaChatBuffer, chatMsg);
    broadcast({ type: 'trivia-chat', data: chatMsg });

    if (!autoMatch) return { correct: false, stored: true, chatId: chatMsg.id };

    const normalized = text.toLowerCase();
    const answers = triviaState.currentQuestion.answers;
    for (let i = 0; i < answers.length; i++) {
      if (triviaState.answersRevealed.includes(i)) continue;
      const answerText = answers[i].text.toLowerCase().trim();
      if (answerText === normalized || answerText.includes(normalized) || normalized.includes(answerText)) {
        triviaState.answersRevealed.push(i);
        answers[i].revealed = true;
        answers[i].answeredBy = user;
        chatMsg.processed = true;
        chatMsg.matchedAnswer = i;

        if (!triviaState.players[user]) triviaState.players[user] = { points: 0, correctAnswers: 0 };
        triviaState.players[user].points += answers[i].points;
        triviaState.players[user].correctAnswers++;

        const allRevealed = triviaState.answersRevealed.length === answers.length;
        console.log(`[Games] Trivia: ${user} got "${answers[i].text}" (+${answers[i].points})`);
        broadcast({
          type: 'trivia-answer-reveal',
          data: { index: i, text: answers[i].text, points: answers[i].points, user, chatMessageId: chatMsg.id, allRevealed }
        });
        return { correct: true, index: i, text: answers[i].text, points: answers[i].points, chatId: chatMsg.id, allRevealed };
      }
    }
    return { correct: false, stored: true, chatId: chatMsg.id };
  }

  // ---------- Movie answer handling ----------
  function submitMovieAnswer(user, answer) {
    if (!movieState.active || !movieState.currentMovie) return { correct: false };
    const text = String(answer || '').trim();
    if (!text || !user) return { correct: false };
    if (isDuplicate(movieChatBuffer, user, text)) return { correct: false, duplicate: true };

    const chatMsg = { id: newId(), user, message: text, timestamp: new Date().toISOString() };
    movieChatBuffer = pushCapped(movieChatBuffer, chatMsg);
    broadcast({ type: 'movie-chat', data: chatMsg });

    if (movieState.answered) return { correct: false, alreadyAnswered: true };

    const normalized = text.toLowerCase();
    const movieName = movieState.currentMovie.name.toLowerCase().trim();
    const isCorrect = movieName === normalized ||
      movieName.includes(normalized) ||
      normalized.includes(movieName) ||
      movieName.replace(/^(the|a|an)\s+/i, '') === normalized.replace(/^(the|a|an)\s+/i, '');
    if (!isCorrect) return { correct: false };

    stopReveal();
    movieState.answered = true;
    movieState.answeredBy = user;
    const points = Math.max(10, Math.round(movieState.pointsPerMovie * (movieState.timeRemaining / movieState.timePerMovie)));
    if (!movieState.players[user]) movieState.players[user] = { points: 0, correctAnswers: 0 };
    movieState.players[user].points += points;
    movieState.players[user].correctAnswers++;

    console.log(`[Games] Movie: ${user} guessed "${movieState.currentMovie.name}" (+${points})`);
    broadcast({
      type: 'movie-correct',
      data: { user, movieName: movieState.currentMovie.name, points, timeRemaining: movieState.timeRemaining, chatMessageId: chatMsg.id }
    });
    return { correct: true, movieName: movieState.currentMovie.name, points, timeRemaining: movieState.timeRemaining };
  }

  /** Twitch chat line from Tower (sync client onChatMessage). */
  function handleChatMessage(msg) {
    if (!msg || !msg.message) return;
    // Score by login name, as the standalone server did (keeps leaderboard keys stable)
    const user = msg.user || msg.displayName;
    try {
      if (triviaState.active && triviaState.currentQuestion) submitTriviaAnswer(user, msg.message, true);
      if (movieState.active && movieState.currentMovie && !movieState.answered) submitMovieAnswer(user, msg.message);
    } catch (e) {
      console.error('[Games] Error handling chat message:', e);
    }
  }

  // ---------- Routes ----------
  const router = express.Router();

  // ===== Trivia =====
  router.get('/api/trivia/categories', (req, res) => {
    if (!fs.existsSync(triviaDir)) return missingDir(res, 'Trivia', triviaDir);
    try {
      const categories = [];
      fs.readdirSync(triviaDir).forEach(dir => {
        const dirPath = path.join(triviaDir, dir);
        if (fs.statSync(dirPath).isDirectory() && dir !== '00 images') {
          const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt'));
          categories.push({ name: dir, questionCount: files.length, answerCount: parseInt(dir) || 3 });
        }
      });
      res.json(categories);
    } catch (e) {
      console.error('[Games] Trivia categories error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/trivia/state', (req, res) => res.json(triviaState));

  router.post('/api/trivia/start', (req, res) => {
    const category = path.basename(String(req.body.category || '4 Answers'));
    const maxQuestions = parseInt(req.body.maxQuestions) || 5;
    const categoryDir = path.join(triviaDir, category);
    if (!fs.existsSync(categoryDir)) return missingDir(res, `Trivia category "${category}"`, categoryDir);

    try {
      const files = fs.readdirSync(categoryDir).filter(f => f.endsWith('.txt'));
      if (files.length === 0) {
        const msg = `No trivia question files (.txt) in ${categoryDir}`;
        console.error(`[Games] ${msg}`);
        return res.status(400).json({ success: false, error: msg });
      }
      const answerCount = parseInt(category.split(' ')[0]) || 4;
      triviaState = {
        active: true, category, answerCount, currentQuestion: null, answersRevealed: [],
        players: {}, questionCount: 0, maxQuestions, availableFiles: files, usedFiles: [], showingIntro: true
      };
      triviaChatBuffer = [];
      console.log(`[Games] Trivia started: ${category}, ${maxQuestions} questions, ${files.length} available`);
      broadcast({ type: 'trivia-intro', data: { maxQuestions, answerCount, category } });
      res.json({ success: true, state: triviaState });
    } catch (e) {
      console.error('[Games] Trivia start error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/api/trivia/next-question', (req, res) => {
    if (!triviaState.active) return res.status(400).json({ error: 'No active trivia game' });
    if (triviaState.questionCount >= triviaState.maxQuestions) return res.status(400).json({ error: 'Max questions reached' });

    triviaState.showingIntro = false;
    triviaChatBuffer = [];

    try {
      const available = triviaState.availableFiles.filter(f => !triviaState.usedFiles.includes(f));
      if (available.length === 0) return res.status(400).json({ error: 'No more questions available' });

      const randomFile = available[Math.floor(Math.random() * available.length)];
      const content = fs.readFileSync(path.join(triviaDir, triviaState.category, randomFile), 'utf8')
        .split('\n').map(l => l.trim());

      // Line 1: question; then alternating answer / points lines
      const question = content[0];
      const answers = [];
      for (let i = 1; i < content.length; i += 2) {
        if (content[i] && content[i + 1]) {
          answers.push({ text: content[i], points: parseInt(content[i + 1]) || 0, revealed: false });
        }
      }
      answers.sort((a, b) => b.points - a.points);

      triviaState.currentQuestion = { question, answers, file: randomFile };
      triviaState.answersRevealed = [];
      triviaState.usedFiles.push(randomFile);
      triviaState.questionCount++;

      broadcast({
        type: 'trivia-question',
        data: {
          question,
          answers: answers.map((a, i) => ({ index: i, revealed: false, text: '???', points: '?' })),
          questionNumber: triviaState.questionCount,
          maxQuestions: triviaState.maxQuestions
        }
      });

      res.json({
        success: true,
        question: {
          question,
          answers: answers.map((a, i) => ({ index: i, text: a.text, points: a.points, revealed: false })),
          questionNumber: triviaState.questionCount,
          maxQuestions: triviaState.maxQuestions
        }
      });
    } catch (e) {
      console.error('[Games] Trivia next-question error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/api/trivia/check-answer', (req, res) => {
    const { answer, user, autoMatch = true } = req.body;
    res.json(submitTriviaAnswer(user, answer, autoMatch));
  });

  router.post('/api/trivia/reveal/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (!triviaState.active || !triviaState.currentQuestion) return res.status(400).json({ error: 'No active question' });
    const answers = triviaState.currentQuestion.answers;
    if (!(index >= 0 && index < answers.length)) return res.status(400).json({ error: 'Invalid answer index' });

    if (!triviaState.answersRevealed.includes(index)) {
      triviaState.answersRevealed.push(index);
      answers[index].revealed = true;
      broadcast({
        type: 'trivia-answer-reveal',
        data: {
          index, text: answers[index].text, points: answers[index].points, auto: true,
          allRevealed: triviaState.answersRevealed.length === answers.length
        }
      });
    }
    res.json({ success: true });
  });

  router.post('/api/trivia/reveal-all', (req, res) => {
    if (!triviaState.active || !triviaState.currentQuestion) return res.status(400).json({ error: 'No active question' });
    const revealed = [];
    triviaState.currentQuestion.answers.forEach((answer, i) => {
      if (!triviaState.answersRevealed.includes(i)) {
        triviaState.answersRevealed.push(i);
        answer.revealed = true;
        revealed.push({ index: i, text: answer.text, points: answer.points });
      }
    });
    broadcast({ type: 'trivia-reveal-all', data: { revealed } });
    res.json({ success: true, revealed });
  });

  router.get('/api/trivia/leaderboard', (req, res) => res.json(sortedLeaderboard(triviaState.players)));

  router.post('/api/trivia/end', (req, res) => {
    const leaderboard = sortedLeaderboard(triviaState.players);
    recordGameResult(leaderboard, { category: triviaState.category, questionCount: triviaState.questionCount });
    broadcast({ type: 'trivia-ended', data: { leaderboard } });
    console.log(`[Games] Trivia ended, ${leaderboard.length} players`);
    triviaState.active = false;
    triviaChatBuffer = [];
    res.json({ success: true, leaderboard });
  });

  // Chat line from Streamerbot or manual entry - stored, not auto-matched
  router.post('/api/trivia/chat', (req, res) => {
    const { user, message, timestamp } = req.body;
    if (!triviaState.active || !triviaState.currentQuestion) return res.json({ stored: false });
    const chatMsg = {
      id: newId(), user, message, timestamp: timestamp || new Date().toISOString(),
      processed: false, matchedAnswer: null
    };
    triviaChatBuffer = pushCapped(triviaChatBuffer, chatMsg);
    broadcast({ type: 'trivia-chat', data: chatMsg });
    res.json({ stored: true, id: chatMsg.id });
  });

  router.get('/api/trivia/chat', (req, res) => res.json(triviaChatBuffer));

  router.post('/api/trivia/chat/clear', (req, res) => {
    triviaChatBuffer = [];
    res.json({ success: true });
  });

  // Manually award an answer to a user (overrides an earlier award)
  router.post('/api/trivia/award', (req, res) => {
    const { answerIndex, user, chatMessageId } = req.body;
    if (!triviaState.active || !triviaState.currentQuestion) return res.status(400).json({ error: 'No active question' });
    const answers = triviaState.currentQuestion.answers;
    if (!(answerIndex >= 0 && answerIndex < answers.length)) return res.status(400).json({ error: 'Invalid answer index' });

    const answer = answers[answerIndex];
    if (answer.revealed && answer.answeredBy && answer.answeredBy !== user) {
      const prev = triviaState.players[answer.answeredBy];
      if (prev) {
        prev.points -= answer.points;
        prev.correctAnswers--;
        if (prev.points <= 0 && prev.correctAnswers <= 0) delete triviaState.players[answer.answeredBy];
      }
    }
    if (!triviaState.players[user]) triviaState.players[user] = { points: 0, correctAnswers: 0 };
    if (!answer.revealed || answer.answeredBy !== user) {
      triviaState.players[user].points += answer.points;
      triviaState.players[user].correctAnswers++;
    }
    answer.revealed = true;
    answer.answeredBy = user;
    answer.awardedManually = true;
    if (!triviaState.answersRevealed.includes(answerIndex)) triviaState.answersRevealed.push(answerIndex);

    if (chatMessageId) {
      const chatMsg = triviaChatBuffer.find(m => m.id === chatMessageId);
      if (chatMsg) { chatMsg.processed = true; chatMsg.matchedAnswer = answerIndex; }
    }
    console.log(`[Games] Trivia: manually awarded "${answer.text}" to ${user}`);
    broadcast({
      type: 'trivia-answer-reveal',
      data: {
        index: answerIndex, text: answer.text, points: answer.points, user, chatMessageId, manual: true,
        allRevealed: triviaState.answersRevealed.length === answers.length
      }
    });
    res.json({ success: true, answer: { index: answerIndex, text: answer.text, points: answer.points, user } });
  });

  // ===== Movies =====
  function listMovieFiles() {
    return fs.readdirSync(moviesDir).filter(f => IMAGE_RE.test(f));
  }

  router.get('/api/movies/available', (req, res) => {
    if (!fs.existsSync(moviesDir)) {
      const msg = `Movies folder not found: ${moviesDir}`;
      console.error(`[Games] ${msg}`);
      return res.json({ count: 0, movies: [], path: moviesDir, error: msg });
    }
    try {
      const files = listMovieFiles();
      res.json({ count: files.length, movies: files.map(f => f.replace(/\.[^.]+$/, '')), path: moviesDir });
    } catch (e) {
      console.error('[Games] Movies list error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/movies/state', (req, res) => res.json({ ...movieState, revealInterval: null }));

  router.post('/api/movies/start', (req, res) => {
    const maxMovies = parseInt(req.body.maxMovies) || 5;
    const totalGameTime = parseInt(req.body.totalGameTime) || 180;
    const pointsPerMovie = parseInt(req.body.pointsPerMovie) || 500;

    if (!fs.existsSync(moviesDir)) return missingDir(res, 'Movies', moviesDir);
    try {
      const files = listMovieFiles();
      if (files.length === 0) {
        const msg = 'No movie images found. Add images to: ' + moviesDir;
        console.error(`[Games] ${msg}`);
        return res.status(400).json({ success: false, error: msg });
      }
      stopReveal();
      const actualMax = Math.min(maxMovies, files.length);
      const timePerMovie = Math.max(1, Math.floor(totalGameTime / actualMax));
      movieState = {
        active: true, currentMovie: null, revealLevel: 0, answered: false, answeredBy: null,
        players: {}, movieCount: 0, maxMovies: actualMax, usedMovies: [], availableMovies: files,
        pointsPerMovie, totalGameTime, timePerMovie, movieStartTime: null,
        timeRemaining: timePerMovie, tileRevealOrder: []
      };
      movieChatBuffer = [];
      console.log(`[Games] Movie game started: ${actualMax} movies, ${timePerMovie}s each, ${files.length} available`);
      broadcast({ type: 'movie-started', data: { maxMovies: actualMax, timePerMovie } });
      res.json({ success: true, totalMovies: files.length, maxMovies: actualMax, timePerMovie });
    } catch (e) {
      console.error('[Games] Movie start error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/api/movies/intro', (req, res) => {
    if (!movieState.active) return res.status(400).json({ error: 'No active movie game' });
    broadcast({
      type: 'movie-intro',
      data: { maxMovies: movieState.maxMovies, pointsPerMovie: movieState.pointsPerMovie, timePerMovie: movieState.timePerMovie }
    });
    res.json({ success: true });
  });

  router.post('/api/movies/next', (req, res) => {
    if (!movieState.active) return res.status(400).json({ error: 'No active movie game' });
    if (movieState.movieCount >= movieState.maxMovies) return res.status(400).json({ error: 'Max movies reached' });
    stopReveal();

    const available = movieState.availableMovies.filter(f => !movieState.usedMovies.includes(f));
    if (available.length === 0) return res.status(400).json({ error: 'No more movies available' });

    const randomFile = available[Math.floor(Math.random() * available.length)];
    const movieName = randomFile.replace(/\.[^.]+$/, '');
    movieState.currentMovie = { file: randomFile, name: movieName, path: `/media/Games/Movies/${randomFile}` };
    movieState.revealLevel = 0;
    movieState.answered = false;
    movieState.answeredBy = null;
    movieState.usedMovies.push(randomFile);
    movieState.movieCount++;
    movieState.movieStartTime = Date.now();
    movieState.timeRemaining = movieState.timePerMovie;
    movieState.tileRevealOrder = generateTileRevealOrder(40);
    movieChatBuffer = [];

    broadcast({
      type: 'movie-question',
      data: {
        movieNumber: movieState.movieCount, maxMovies: movieState.maxMovies,
        imagePath: movieState.currentMovie.path, revealLevel: 0,
        timePerMovie: movieState.timePerMovie, timeRemaining: movieState.timePerMovie,
        pointsAvailable: movieState.pointsPerMovie, tileRevealOrder: movieState.tileRevealOrder
      }
    });

    let elapsed = 0;
    revealInterval = setInterval(() => {
      if (!movieState.active || movieState.answered) { stopReveal(); return; }
      elapsed++;
      movieState.revealLevel = Math.min(100, (elapsed / movieState.timePerMovie) * 100);
      movieState.timeRemaining = Math.max(0, movieState.timePerMovie - elapsed);
      const pointsAvailable = Math.round(movieState.pointsPerMovie * (movieState.timeRemaining / movieState.timePerMovie));
      broadcast({
        type: 'movie-reveal',
        data: { revealLevel: movieState.revealLevel, timeRemaining: movieState.timeRemaining, pointsAvailable }
      });
      if (movieState.timeRemaining <= 0) {
        stopReveal();
        broadcast({ type: 'movie-timeout', data: { movieName: movieState.currentMovie.name, revealLevel: 100 } });
      }
    }, 1000);

    console.log(`[Games] Movie ${movieState.movieCount}/${movieState.maxMovies}: ${movieName}`);
    res.json({
      success: true,
      movie: { name: movieName, file: randomFile, number: movieState.movieCount, maxMovies: movieState.maxMovies, timePerMovie: movieState.timePerMovie }
    });
  });

  router.post('/api/movies/check-answer', (req, res) => {
    const { answer, user } = req.body;
    res.json(submitMovieAnswer(user, answer));
  });

  router.post('/api/movies/reveal', (req, res) => {
    if (!movieState.active || !movieState.currentMovie) return res.status(400).json({ error: 'No active movie' });
    stopReveal();
    movieState.revealLevel = 100;
    movieState.answered = true;
    broadcast({ type: 'movie-timeout', data: { movieName: movieState.currentMovie.name, revealLevel: 100, skipped: true } });
    res.json({ success: true, movieName: movieState.currentMovie.name });
  });

  router.post('/api/movies/end', (req, res) => {
    stopReveal();
    const leaderboard = sortedLeaderboard(movieState.players);
    recordGameResult(leaderboard, { gameType: 'movie', movieCount: movieState.movieCount });
    broadcast({ type: 'movie-ended', data: { leaderboard } });
    console.log(`[Games] Movie game ended, ${leaderboard.length} players`);
    movieState.active = false;
    movieChatBuffer = [];
    res.json({ success: true, leaderboard });
  });

  router.get('/api/movies/chat', (req, res) => res.json(movieChatBuffer));

  // ===== Cumulative game stats =====
  router.get('/api/games/leaderboard', (req, res) => {
    const gs = store.stats;
    const players = Object.entries(gs.players)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.totalPoints - a.totalPoints);
    res.json({ players, periodStart: gs.periodStart, placementPoints: gs.placementPoints, totalGames: gs.history.length });
  });

  router.get('/api/games/placement-points', (req, res) => res.json(store.stats.placementPoints));

  router.post('/api/games/placement-points', (req, res) => {
    const { first, second, third } = req.body;
    store.stats.placementPoints = {
      first: parseInt(first) || 3,
      second: parseInt(second) || 2,
      third: parseInt(third) || 1
    };
    store.save();
    res.json({ success: true, placementPoints: store.stats.placementPoints });
  });

  router.get('/api/games/history', (req, res) => res.json({ history: store.stats.history }));

  router.post('/api/games/reset-period', (req, res) => {
    const keepHistory = !!req.body.keepHistory;
    const previousStats = { ...store.stats };
    const next = freshGameStats(store.stats.placementPoints);
    if (keepHistory) next.history = store.stats.history;
    store.stats = next;
    store.save();
    console.log('[Games] Leaderboard period reset');
    res.json({ success: true, message: 'Period reset successfully', previousStats });
  });

  router.get('/api/games/export', (req, res) => {
    const gs = store.stats;
    res.json({
      exportDate: new Date().toISOString(),
      periodStart: gs.periodStart,
      placementPoints: gs.placementPoints,
      leaderboard: Object.entries(gs.players)
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.totalPoints - a.totalPoints),
      totalGames: gs.history.length,
      recentGames: gs.history.slice(-10)
    });
  });

  router.delete('/api/games/player/:name', (req, res) => {
    const name = req.params.name;
    if (!store.stats.players[name]) return res.status(404).json({ error: 'Player not found' });
    delete store.stats.players[name];
    store.save();
    res.json({ success: true, message: `Player ${name} removed` });
  });

  function close() {
    stopReveal();
  }

  return { router, handleChatMessage, close };
}

module.exports = { createGames };
