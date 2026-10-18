const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');

// Twitch integration
const { RefreshingAuthProvider } = require('@twurple/auth');
const { ChatClient } = require('@twurple/chat');
const { ApiClient } = require('@twurple/api');
const { EventSubWsListener } = require('@twurple/eventsub-ws');

// Get app root (works for both dev and packaged)
const appRoot = process.resourcesPath
  ? path.dirname(process.resourcesPath)
  : path.join(__dirname, '../..');

// Store data in a persistent location outside the dist folder
const persistentDataDir = 'C:\\Streaming\\Programs\\StreamCompanion\\data';

const CONFIG = {
  httpPort: 8877,
  wsPort: 8878,
  // Always serve overlays from the source folder for consistency
  overlaysDir: 'C:\\Streaming\\Programs\\StreamCompanion\\src\\overlays',
  dataDir: persistentDataDir,
  watchDir: 'C:\\Streaming\\WatchFiles',
  triviaDir: 'C:\\Streaming\\Media\\Games\\Trivia',
  moviesDir: 'C:\\Streaming\\Media\\Games\\Movies',
  dbdDir: 'C:\\Streaming\\Media\\Games\\DBD'
};

// DBD Killer Challenge - Full 44 killer roster (Aug 2026)
const FULL_KILLER_ROSTER = [
  'Trapper', 'Wraith', 'Hillbilly', 'Nurse', 'Shape', 'Hag', 'Doctor', 'Huntress',
  'Cannibal', 'Nightmare', 'Pig', 'Clown', 'Spirit', 'Legion', 'Plague', 'Ghost Face',
  'Demogorgon', 'Oni', 'Deathslinger', 'Executioner', 'Blight', 'Twins', 'Trickster',
  'Nemesis', 'Cenobite', 'Artist', 'Onryo', 'Dredge', 'Mastermind', 'Knight',
  'Skull Merchant', 'Singularity', 'Xenomorph', 'Good Guy', 'Unknown', 'Lich',
  'Dark Lord', 'Houndmaster', 'Ghoul', 'Animatronic', 'Krasue', 'First', 'Slasher', 'Judgment'
];

// Default tier configuration (standard placement)
const DEFAULT_TIER_CONFIG = {
  free: { name: 'Free', cost: 0, killers: ['Trapper', 'Skull Merchant'] },
  ash: { name: 'Ash', cost: 2, killers: ['Wraith', 'Hag', 'Doctor', 'Shape', 'Pig', 'Legion', 'Onryo', 'Krasue'] },
  bronze: { name: 'Bronze', cost: 3, killers: ['Clown', 'Nightmare', 'Spirit', 'Ghost Face', 'Demogorgon', 'Trickster', 'Good Guy', 'Unknown', 'Slasher'] },
  silver: { name: 'Silver', cost: 4, killers: ['Cannibal', 'Deathslinger', 'Knight', 'Dredge', 'Cenobite', 'Nemesis', 'Xenomorph', 'Lich', 'First'] },
  gold: { name: 'Gold', cost: 5, killers: ['Huntress', 'Plague', 'Oni', 'Executioner', 'Artist', 'Mastermind', 'Singularity', 'Houndmaster', 'Judgment'] },
  iri: { name: 'Iridescent', cost: 8, killers: ['Nurse', 'Hillbilly', 'Blight', 'Twins', 'Dark Lord', 'Ghoul', 'Animatronic'] }
};

// Difficulty presets - Based on MAX 4 points per game (kills only, no pips)
// 44 killers * 4 kills max = 176 max possible points from games
const DIFFICULTY_PRESETS = {
  easy: {
    name: 'Easy',
    description: 'Avg ~2 kills needed per game',
    startingPoints: 5,
    tierCosts: { free: 0, ash: 1, bronze: 2, silver: 2, gold: 3, iri: 4 },
    distribution: { free: 2, ash: 8, bronze: 9, silver: 9, gold: 9, iri: 7 }
    // Total cost: 0 + 8 + 18 + 18 + 27 + 28 = 99. Need 94 from games = 2.14 avg
  },
  standard: {
    name: 'Standard',
    description: 'Avg ~2.5 kills needed per game',
    startingPoints: 3,
    tierCosts: { free: 0, ash: 1, bronze: 2, silver: 3, gold: 4, iri: 5 },
    distribution: { free: 2, ash: 8, bronze: 9, silver: 9, gold: 9, iri: 7 }
    // Total cost: 0 + 8 + 18 + 27 + 36 + 35 = 124. Need 121 from games = 2.75 avg
  },
  hard: {
    name: 'Hard',
    description: 'Avg ~3 kills needed per game',
    startingPoints: 2,
    tierCosts: { free: 0, ash: 2, bronze: 3, silver: 3, gold: 4, iri: 6 },
    distribution: { free: 2, ash: 8, bronze: 9, silver: 9, gold: 9, iri: 7 }
    // Total cost: 0 + 16 + 27 + 27 + 36 + 42 = 148. Need 146 from games = 3.32 avg
  },
  hardcore: {
    name: 'Hardcore',
    description: 'Avg ~3.5 kills needed - near perfect play',
    startingPoints: 1,
    tierCosts: { free: 0, ash: 2, bronze: 3, silver: 4, gold: 5, iri: 7 },
    distribution: { free: 2, ash: 8, bronze: 9, silver: 9, gold: 9, iri: 7 }
    // Total cost: 0 + 16 + 27 + 36 + 45 + 49 = 173. Need 172 from games = 3.91 avg
  }
};

// Available challenge types
const DBD_CHALLENGE_TYPES = {
  'barebones-endurance': {
    id: 'barebones-endurance',
    name: 'Barebones Endurance Challenge',
    description: 'No addons, no perks. Play all killers before running out of points. Ultimate goal: move all killers to Free tier!',
    rules: [
      'Each killer costs points based on their tier',
      'Earn 1 point per kill (max 4 per game)',
      'Complete a game with each killer',
      'If points hit 0, challenge resets with randomized tiers',
      'Win a run to promote a killer to Free tier'
    ],
    pointsPerKill: 1,
    pointsPerPip: 0, // No pip points in this challenge
    maxPointsPerGame: 4
  }
  // Future challenge types can be added here
};

// Challenge configuration state
let dbdChallengeConfig = {
  challengeType: 'barebones-endurance',
  preset: 'standard',
  startingPoints: 3,
  tierCosts: { free: 0, ash: 1, bronze: 2, silver: 3, gold: 4, iri: 5 },
  distribution: { free: 2, ash: 8, bronze: 9, silver: 9, gold: 9, iri: 7 }
};

// Calculate challenge difficulty metrics
function calculateChallengeMetrics(config) {
  const { startingPoints, tierCosts, distribution } = config;

  // Total cost to play all killers
  let totalCost = 0;
  let totalKillers = 0;
  Object.keys(distribution).forEach(tier => {
    totalCost += tierCosts[tier] * distribution[tier];
    totalKillers += distribution[tier];
  });

  // Max possible earnings = 4 kills per game (no pips in this challenge)
  const maxPossibleEarnings = totalKillers * 4;

  // Minimum average kills needed per game to complete
  const minAvgNeeded = (totalCost - startingPoints) / totalKillers;

  // Point buffer - how many points you can "lose" and still complete
  const pointBuffer = maxPossibleEarnings + startingPoints - totalCost;

  // Determine difficulty based on minimum average kills needed
  // Max is 4 kills per game
  let difficultyRating;
  if (minAvgNeeded > 4) difficultyRating = 'Impossible';
  else if (minAvgNeeded > 3.5) difficultyRating = 'Hardcore';
  else if (minAvgNeeded > 3) difficultyRating = 'Hard';
  else if (minAvgNeeded > 2.5) difficultyRating = 'Standard';
  else difficultyRating = 'Easy';

  return {
    totalCost,
    totalKillers,
    maxPossibleEarnings,
    pointBuffer,
    minAvgNeeded: Math.round(minAvgNeeded * 100) / 100,
    isCompletable: minAvgNeeded <= 4,
    difficultyRating
  };
}

// DBD Challenge state
let dbdChallengeState = {
  active: false,
  challengeType: 'barebones-endurance',
  challengeName: 'Barebones Endurance Challenge',
  season: 1,          // Current season/run number
  runNumber: 1,       // Run within the season
  currentPoints: 0,
  gamesPlayed: 0,
  totalKills: 0,
  killers: {}, // { killerName: { played: false, kills: 0, threeK: false, fourK: false } }
  tiers: {},
  freePoolKillers: ['Trapper', 'Skull Merchant'], // Killers permanently in free tier
  history: [],        // Game history for current run
  seasonHistory: [],  // All runs in this season
  currentKiller: null,
  startedAt: null,
  config: null,       // Stores the config used for this challenge
  metrics: null       // Calculated difficulty metrics
};

// DBD Tracker API integration state
let dbdTrackerState = {
  apiUrl: null,           // Full URL with ?key=...
  lastExternalId: null,   // Last processed match ID for deduping
  processedIds: new Set(),// All processed IDs this session
  autoPolling: false,     // Whether background polling is enabled
  pollInterval: null,     // Interval handle
  lastCheck: null,        // Timestamp of last check
  pendingMatch: null      // Match fetched but not yet applied
};

// Trivia game state
let triviaState = {
  active: false,
  currentQuestion: null,
  answersRevealed: [],
  players: {},
  questionCount: 0,
  maxQuestions: 5
};

// Chat message buffer for trivia (stores messages during active question)
let triviaChatBuffer = [];

// Movie game state
let movieState = {
  active: false,
  currentMovie: null,
  revealLevel: 0, // 0-100 (0 = fully hidden, 100 = fully revealed)
  answered: false,
  answeredBy: null,
  players: {},
  movieCount: 0,
  maxMovies: 5,
  usedMovies: [],
  availableMovies: [],
  revealInterval: null,
  pointsPerMovie: 500, // Max points per movie
  totalGameTime: 180, // Total game time in seconds
  timePerMovie: 36, // Calculated: totalGameTime / maxMovies
  movieStartTime: null, // When current movie started
  timeRemaining: 0, // Seconds remaining for current movie
  tileRevealOrder: [] // Random order for tile reveals
};

// Chat buffer for movie game
let movieChatBuffer = [];

// ========== TWITCH INTEGRATION ==========
let twitchState = {
  connected: false,
  channel: null,
  username: null,
  authProvider: null,
  chatClient: null,
  apiClient: null,
  eventSub: null,
  userId: null,
  recentMessages: [], // Last 50 chat messages
  eventLog: [] // Recent events (follows, subs, etc.)
};

// Twitch event handlers
function handleTwitchMessage(channel, user, message, msg) {
  const chatMsg = {
    id: Date.now(),
    channel: channel,
    user: user,
    displayName: msg.userInfo.displayName,
    message: message,
    color: msg.userInfo.color,
    badges: Array.from(msg.userInfo.badges.keys()),
    isSubscriber: msg.userInfo.isSubscriber,
    isMod: msg.userInfo.isMod,
    isVip: msg.userInfo.isVip,
    isBroadcaster: msg.userInfo.isBroadcaster,
    timestamp: new Date().toISOString()
  };

  // Store in recent messages
  twitchState.recentMessages.push(chatMsg);
  if (twitchState.recentMessages.length > 50) {
    twitchState.recentMessages = twitchState.recentMessages.slice(-50);
  }

  // Broadcast to app
  broadcastToClients({
    type: 'twitch-chat',
    data: chatMsg
  });

  // Route to active games
  if (triviaState.active && triviaState.currentQuestion) {
    // Auto-check trivia answer
    routeToTrivia(user, message);
  }

  if (movieState.active && movieState.currentMovie && !movieState.answered) {
    // Auto-check movie answer
    routeToMovieGame(user, message);
  }
}

function routeToTrivia(user, message) {
  const normalizedAnswer = message.toLowerCase().trim();
  const answers = triviaState.currentQuestion.answers;

  for (let i = 0; i < answers.length; i++) {
    if (!triviaState.answersRevealed.includes(i)) {
      const answerText = answers[i].text.toLowerCase().trim();
      if (answerText === normalizedAnswer || answerText.includes(normalizedAnswer) || normalizedAnswer.includes(answerText)) {
        // Match found - award points
        triviaState.answersRevealed.push(i);
        answers[i].revealed = true;
        answers[i].answeredBy = user;

        if (!triviaState.players[user]) {
          triviaState.players[user] = { points: 0, correctAnswers: 0 };
        }
        triviaState.players[user].points += answers[i].points;
        triviaState.players[user].correctAnswers++;

        broadcastToClients({
          type: 'trivia-answer-reveal',
          data: {
            index: i,
            text: answers[i].text,
            points: answers[i].points,
            user: user,
            allRevealed: triviaState.answersRevealed.length === answers.length
          }
        });
        break;
      }
    }
  }
}

function routeToMovieGame(user, message) {
  const normalizedAnswer = message.toLowerCase().trim();
  const movieName = movieState.currentMovie.name.toLowerCase().trim();

  const isCorrect = movieName === normalizedAnswer ||
    movieName.includes(normalizedAnswer) ||
    normalizedAnswer.includes(movieName) ||
    movieName.replace(/^(the|a|an)\s+/i, '') === normalizedAnswer.replace(/^(the|a|an)\s+/i, '');

  if (isCorrect) {
    if (movieState.revealInterval) {
      clearInterval(movieState.revealInterval);
    }

    movieState.answered = true;
    movieState.answeredBy = user;

    const points = Math.max(10, Math.round(movieState.pointsPerMovie * (movieState.timeRemaining / movieState.timePerMovie)));

    if (!movieState.players[user]) {
      movieState.players[user] = { points: 0, correctAnswers: 0 };
    }
    movieState.players[user].points += points;
    movieState.players[user].correctAnswers++;

    broadcastToClients({
      type: 'movie-correct',
      data: {
        user: user,
        movieName: movieState.currentMovie.name,
        points: points,
        timeRemaining: movieState.timeRemaining
      }
    });
  }
}

function logTwitchEvent(type, data) {
  const event = {
    id: Date.now(),
    type: type,
    data: data,
    timestamp: new Date().toISOString()
  };

  twitchState.eventLog.push(event);
  if (twitchState.eventLog.length > 100) {
    twitchState.eventLog = twitchState.eventLog.slice(-100);
  }

  broadcastToClients({
    type: 'twitch-event',
    data: event
  });
}

async function connectTwitch(clientId, clientSecret, accessToken, refreshToken, channel) {
  try {
    // Disconnect existing connection
    await disconnectTwitch();

    // Set up auth provider
    twitchState.authProvider = new RefreshingAuthProvider({
      clientId,
      clientSecret
    });

    twitchState.authProvider.onRefresh((userId, newTokenData) => {
      // Save refreshed tokens
      if (db.twitch) {
        db.twitch.accessToken = newTokenData.accessToken;
        db.twitch.refreshToken = newTokenData.refreshToken;
        db.twitch.expiresIn = newTokenData.expiresIn;
        db.twitch.obtainmentTimestamp = newTokenData.obtainmentTimestamp;
        saveDB(db);
      }
    });

    await twitchState.authProvider.addUserForToken({
      accessToken,
      refreshToken,
      expiresIn: 0,
      obtainmentTimestamp: 0
    }, ['chat']);

    // Create API client
    twitchState.apiClient = new ApiClient({ authProvider: twitchState.authProvider });

    // Get user info
    const user = await twitchState.apiClient.users.getUserByName(channel);
    if (!user) {
      throw new Error(`Channel "${channel}" not found`);
    }
    twitchState.userId = user.id;
    twitchState.username = user.name;
    twitchState.channel = channel;

    // Create chat client
    twitchState.chatClient = new ChatClient({
      authProvider: twitchState.authProvider,
      channels: [channel]
    });

    twitchState.chatClient.onMessage((channel, user, message, msg) => {
      handleTwitchMessage(channel, user, message, msg);
    });

    twitchState.chatClient.onConnect(() => {
      console.log('Twitch chat connected to #' + channel);
      twitchState.connected = true;
      broadcastToClients({ type: 'twitch-status', data: { connected: true, channel } });
    });

    twitchState.chatClient.onDisconnect((manually, reason) => {
      console.log('Twitch chat disconnected:', reason);
      twitchState.connected = false;
      broadcastToClients({ type: 'twitch-status', data: { connected: false } });
    });

    await twitchState.chatClient.connect();

    // Set up EventSub for events
    twitchState.eventSub = new EventSubWsListener({ apiClient: twitchState.apiClient });

    // Subscribe to events
    twitchState.eventSub.onChannelFollow(twitchState.userId, twitchState.userId, (event) => {
      logTwitchEvent('follow', {
        user: event.userName,
        displayName: event.userDisplayName
      });
    });

    twitchState.eventSub.onChannelSubscription(twitchState.userId, (event) => {
      logTwitchEvent('subscription', {
        user: event.userName,
        displayName: event.userDisplayName,
        tier: event.tier,
        isGift: event.isGift
      });
    });

    twitchState.eventSub.onChannelSubscriptionGift(twitchState.userId, (event) => {
      logTwitchEvent('subscription-gift', {
        user: event.gifterName,
        displayName: event.gifterDisplayName,
        amount: event.amount,
        tier: event.tier,
        total: event.cumulativeAmount
      });
    });

    twitchState.eventSub.onChannelRaid(twitchState.userId, (event) => {
      logTwitchEvent('raid', {
        user: event.raidingBroadcasterName,
        displayName: event.raidingBroadcasterDisplayName,
        viewers: event.viewers
      });
    });

    twitchState.eventSub.onChannelCheer(twitchState.userId, (event) => {
      logTwitchEvent('cheer', {
        user: event.userName,
        displayName: event.userDisplayName,
        bits: event.bits,
        message: event.message
      });
    });

    twitchState.eventSub.onChannelRedemptionAdd(twitchState.userId, (event) => {
      logTwitchEvent('redemption', {
        user: event.userName,
        displayName: event.userDisplayName,
        reward: event.rewardTitle,
        cost: event.rewardCost,
        input: event.input
      });
    });

    await twitchState.eventSub.start();
    console.log('Twitch EventSub connected');

    return { success: true, channel, username: twitchState.username };
  } catch (e) {
    console.error('Twitch connection error:', e);
    twitchState.connected = false;
    throw e;
  }
}

async function disconnectTwitch() {
  try {
    if (twitchState.eventSub) {
      await twitchState.eventSub.stop();
      twitchState.eventSub = null;
    }
    if (twitchState.chatClient) {
      twitchState.chatClient.quit();
      twitchState.chatClient = null;
    }
    twitchState.authProvider = null;
    twitchState.apiClient = null;
    twitchState.connected = false;
    twitchState.channel = null;
    twitchState.userId = null;
    console.log('Twitch disconnected');
  } catch (e) {
    console.error('Error disconnecting Twitch:', e);
  }
}

// Ensure data directory exists
if (!fs.existsSync(CONFIG.dataDir)) {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
}

const DB_FILE = path.join(CONFIG.dataDir, 'companion.json');

// Initialize database
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading DB:', e.message);
  }
  return {
    alerts: [],
    actions: [],
    games: [],
    settings: {
      streamerbot: { host: '127.0.0.1', port: 8080 },
      obs: { host: '127.0.0.1', port: 4455 }
    },
    // Cumulative game tracking
    gameStats: {
      players: {}, // { username: { totalPoints, wins, secondPlace, thirdPlace, gamesPlayed, lastPlayed } }
      placementPoints: { first: 3, second: 2, third: 1 },
      history: [], // Array of game results
      periodStart: new Date().toISOString()
    }
  };
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error saving DB:', e.message);
  }
}

let db = loadDB();
console.log('Database loaded');

// Watch for file changes
if (fs.existsSync(CONFIG.watchDir)) {
  const watcher = chokidar.watch(CONFIG.watchDir, { persistent: true });
  watcher.on('change', (filepath) => {
    console.log('File changed:', filepath);
    broadcastToClients({ type: 'file-change', path: filepath });
  });
  console.log(`Watching ${CONFIG.watchDir} for file changes`);
}

// WebSocket server
let wss;
try {
  wss = new WebSocketServer({ port: CONFIG.wsPort });
  wss.on('error', (err) => {
    console.error('WebSocket server error:', err.message);
  });
  wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        handleWebSocketMessage(ws, data);
      } catch (e) {
        console.error('WebSocket message error:', e.message);
      }
    });
    ws.on('error', (err) => {
      console.error('WebSocket client error:', err.message);
    });
  });
} catch (e) {
  console.error('Failed to start WebSocket server:', e.message);
}

function broadcastToClients(data) {
  if (!wss) return;
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function handleWebSocketMessage(ws, data) {
  switch (data.type) {
    case 'get-alerts':
      ws.send(JSON.stringify({ type: 'alerts', data: db.alerts }));
      break;
    case 'get-actions':
      ws.send(JSON.stringify({ type: 'actions', data: db.actions }));
      break;
    case 'get-games':
      ws.send(JSON.stringify({ type: 'games', data: db.games }));
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
  }
}

// Express HTTP server
const app = express();
app.use(express.json());
app.use(express.static(CONFIG.overlaysDir));

// Serve media files from C:\Streaming\Media
app.use('/media', express.static('C:\\Streaming\\Media'));

// Serve killer portraits from C:\Streaming\DBD Portraits\killers
app.use('/media/killers', express.static('C:\\Streaming\\DBD Portraits\\killers'));

// API endpoints
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/alerts', (req, res) => {
  res.json(db.alerts);
});

app.post('/api/alerts', (req, res) => {
  const alert = { id: Date.now(), ...req.body, createdAt: new Date().toISOString() };
  db.alerts.unshift(alert);
  if (db.alerts.length > 100) db.alerts = db.alerts.slice(0, 100);
  saveDB(db);
  broadcastToClients({ type: 'new-alert', data: alert });
  res.json(alert);
});

app.get('/api/actions', (req, res) => {
  res.json(db.actions);
});

app.post('/api/actions', (req, res) => {
  const action = { id: Date.now(), ...req.body };
  db.actions.push(action);
  saveDB(db);
  res.json(action);
});

app.get('/api/games', (req, res) => {
  res.json(db.games);
});

app.post('/api/games', (req, res) => {
  const game = { id: Date.now(), ...req.body };
  db.games.push(game);
  saveDB(db);
  res.json(game);
});

app.get('/api/settings', (req, res) => {
  res.json(db.settings);
});

app.post('/api/settings', (req, res) => {
  db.settings = { ...db.settings, ...req.body };
  saveDB(db);
  res.json(db.settings);
});

// ==========================================
// TRIVIA GAME API
// ==========================================

// Get available trivia categories (3, 4, 5 answer variants)
app.get('/api/trivia/categories', (req, res) => {
  const categories = [];
  try {
    const dirs = fs.readdirSync(CONFIG.triviaDir);
    dirs.forEach(dir => {
      const dirPath = path.join(CONFIG.triviaDir, dir);
      if (fs.statSync(dirPath).isDirectory() && dir !== '00 images') {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt'));
        categories.push({
          name: dir,
          questionCount: files.length,
          answerCount: parseInt(dir) || 3
        });
      }
    });
    res.json(categories);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get trivia game state
app.get('/api/trivia/state', (req, res) => {
  res.json(triviaState);
});

// Start a new trivia game
app.post('/api/trivia/start', (req, res) => {
  const { category, maxQuestions = 5 } = req.body;

  try {
    const categoryDir = path.join(CONFIG.triviaDir, category || '4 Answers');
    const files = fs.readdirSync(categoryDir).filter(f => f.endsWith('.txt'));

    const answerCount = parseInt((category || '4 Answers').split(' ')[0]) || 4;

    triviaState = {
      active: true,
      category: category || '4 Answers',
      answerCount: answerCount,
      currentQuestion: null,
      answersRevealed: [],
      players: {},
      questionCount: 0,
      maxQuestions: maxQuestions,
      availableFiles: files,
      usedFiles: [],
      showingIntro: true
    };

    // Broadcast intro screen to overlay
    broadcastToClients({
      type: 'trivia-intro',
      data: {
        maxQuestions: maxQuestions,
        answerCount: answerCount,
        category: category || '4 Answers'
      }
    });

    res.json({ success: true, state: triviaState });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get next trivia question
app.post('/api/trivia/next-question', (req, res) => {
  if (!triviaState.active) {
    return res.status(400).json({ error: 'No active trivia game' });
  }

  if (triviaState.questionCount >= triviaState.maxQuestions) {
    return res.status(400).json({ error: 'Max questions reached' });
  }

  // Clear intro state and chat buffer for new question
  triviaState.showingIntro = false;
  triviaChatBuffer = [];

  try {
    // Pick random unused question
    const availableFiles = triviaState.availableFiles.filter(
      f => !triviaState.usedFiles.includes(f)
    );

    if (availableFiles.length === 0) {
      return res.status(400).json({ error: 'No more questions available' });
    }

    const randomFile = availableFiles[Math.floor(Math.random() * availableFiles.length)];
    const filePath = path.join(CONFIG.triviaDir, triviaState.category, randomFile);
    const content = fs.readFileSync(filePath, 'utf8').split('\n').map(l => l.trim());

    // Parse question file format:
    // Line 1: Question
    // Lines 2+: alternating Answer, Points
    const question = content[0];
    const answers = [];

    for (let i = 1; i < content.length; i += 2) {
      if (content[i] && content[i + 1]) {
        answers.push({
          text: content[i],
          points: parseInt(content[i + 1]) || 0,
          revealed: false
        });
      }
    }

    // Sort by points (highest first)
    answers.sort((a, b) => b.points - a.points);

    triviaState.currentQuestion = {
      question: question,
      answers: answers,
      file: randomFile
    };
    triviaState.answersRevealed = [];
    triviaState.usedFiles.push(randomFile);
    triviaState.questionCount++;

    // Send to overlay (hide answers initially)
    const overlayQuestion = {
      question: question,
      answers: answers.map((a, i) => ({
        index: i,
        revealed: false,
        text: '???',
        points: '?'
      })),
      questionNumber: triviaState.questionCount,
      maxQuestions: triviaState.maxQuestions
    };

    broadcastToClients({ type: 'trivia-question', data: overlayQuestion });

    // Return full answers to companion app (for host view)
    const hostQuestion = {
      question: question,
      answers: answers.map((a, i) => ({
        index: i,
        text: a.text,
        points: a.points,
        revealed: false
      })),
      questionNumber: triviaState.questionCount,
      maxQuestions: triviaState.maxQuestions
    };

    res.json({ success: true, question: hostQuestion });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check trivia answer (from chat)
app.post('/api/trivia/check-answer', (req, res) => {
  const { answer, user, autoMatch = true } = req.body;

  if (!triviaState.active || !triviaState.currentQuestion) {
    return res.json({ correct: false });
  }

  // Store the message in chat buffer
  const chatMsg = {
    id: Date.now(),
    user: user,
    message: answer,
    timestamp: new Date().toISOString(),
    processed: false,
    matchedAnswer: null
  };
  triviaChatBuffer.push(chatMsg);

  // Keep buffer to last 100 messages
  if (triviaChatBuffer.length > 100) {
    triviaChatBuffer = triviaChatBuffer.slice(-100);
  }

  // Broadcast to companion app
  broadcastToClients({
    type: 'trivia-chat',
    data: chatMsg
  });

  // If autoMatch is disabled, just store the message without checking
  if (!autoMatch) {
    return res.json({ correct: false, stored: true, chatId: chatMsg.id });
  }

  const normalizedAnswer = answer.toLowerCase().trim();
  const answers = triviaState.currentQuestion.answers;

  for (let i = 0; i < answers.length; i++) {
    if (!triviaState.answersRevealed.includes(i)) {
      const answerText = answers[i].text.toLowerCase().trim();
      if (answerText === normalizedAnswer || answerText.includes(normalizedAnswer) || normalizedAnswer.includes(answerText)) {
        // Correct answer found!
        triviaState.answersRevealed.push(i);
        answers[i].revealed = true;
        answers[i].answeredBy = user;

        // Mark chat message as matched
        chatMsg.processed = true;
        chatMsg.matchedAnswer = i;

        // Update player points
        if (!triviaState.players[user]) {
          triviaState.players[user] = { points: 0, correctAnswers: 0 };
        }
        triviaState.players[user].points += answers[i].points;
        triviaState.players[user].correctAnswers++;

        // Broadcast reveal
        broadcastToClients({
          type: 'trivia-answer-reveal',
          data: {
            index: i,
            text: answers[i].text,
            points: answers[i].points,
            user: user,
            chatMessageId: chatMsg.id,
            allRevealed: triviaState.answersRevealed.length === answers.length
          }
        });

        return res.json({
          correct: true,
          index: i,
          text: answers[i].text,
          points: answers[i].points,
          chatId: chatMsg.id,
          allRevealed: triviaState.answersRevealed.length === answers.length
        });
      }
    }
  }

  res.json({ correct: false, stored: true, chatId: chatMsg.id });
});

// Reveal specific answer (manual)
app.post('/api/trivia/reveal/:index', (req, res) => {
  const index = parseInt(req.params.index);

  if (!triviaState.active || !triviaState.currentQuestion) {
    return res.status(400).json({ error: 'No active question' });
  }

  const answers = triviaState.currentQuestion.answers;
  if (index < 0 || index >= answers.length) {
    return res.status(400).json({ error: 'Invalid answer index' });
  }

  if (!triviaState.answersRevealed.includes(index)) {
    triviaState.answersRevealed.push(index);
    answers[index].revealed = true;

    broadcastToClients({
      type: 'trivia-answer-reveal',
      data: {
        index: index,
        text: answers[index].text,
        points: answers[index].points,
        auto: true,
        allRevealed: triviaState.answersRevealed.length === answers.length
      }
    });
  }

  res.json({ success: true });
});

// Reveal all remaining answers
app.post('/api/trivia/reveal-all', (req, res) => {
  if (!triviaState.active || !triviaState.currentQuestion) {
    return res.status(400).json({ error: 'No active question' });
  }

  const answers = triviaState.currentQuestion.answers;
  const revealed = [];

  answers.forEach((answer, i) => {
    if (!triviaState.answersRevealed.includes(i)) {
      triviaState.answersRevealed.push(i);
      answer.revealed = true;
      revealed.push({ index: i, text: answer.text, points: answer.points });
    }
  });

  broadcastToClients({
    type: 'trivia-reveal-all',
    data: { revealed: revealed }
  });

  res.json({ success: true, revealed: revealed });
});

// Get leaderboard
app.get('/api/trivia/leaderboard', (req, res) => {
  const leaderboard = Object.entries(triviaState.players)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.points - a.points);

  res.json(leaderboard);
});

// End trivia game
app.post('/api/trivia/end', (req, res) => {
  const leaderboard = Object.entries(triviaState.players)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.points - a.points);

  // Initialize gameStats if not present
  if (!db.gameStats) {
    db.gameStats = {
      players: {},
      placementPoints: { first: 3, second: 2, third: 1 },
      history: [],
      periodStart: new Date().toISOString()
    };
  }

  const placementPoints = db.gameStats.placementPoints;

  // Award placement points to top 3
  leaderboard.forEach((player, index) => {
    const username = player.name;

    // Initialize player if not exists
    if (!db.gameStats.players[username]) {
      db.gameStats.players[username] = {
        totalPoints: 0,
        wins: 0,
        secondPlace: 0,
        thirdPlace: 0,
        gamesPlayed: 0,
        lastPlayed: null
      };
    }

    const stats = db.gameStats.players[username];
    stats.gamesPlayed++;
    stats.lastPlayed = new Date().toISOString();

    // Award placement points
    if (index === 0) {
      stats.wins++;
      stats.totalPoints += placementPoints.first;
    } else if (index === 1) {
      stats.secondPlace++;
      stats.totalPoints += placementPoints.second;
    } else if (index === 2) {
      stats.thirdPlace++;
      stats.totalPoints += placementPoints.third;
    }
  });

  // Save game to history
  db.gameStats.history.push({
    date: new Date().toISOString(),
    category: triviaState.category,
    questionCount: triviaState.questionCount,
    leaderboard: leaderboard.slice(0, 10).map(p => ({
      name: p.name,
      points: p.points,
      correctAnswers: p.correctAnswers
    }))
  });

  // Keep only last 100 games in history
  if (db.gameStats.history.length > 100) {
    db.gameStats.history = db.gameStats.history.slice(-100);
  }

  saveDB(db);

  broadcastToClients({
    type: 'trivia-ended',
    data: { leaderboard: leaderboard }
  });

  triviaState.active = false;
  triviaChatBuffer = [];
  res.json({ success: true, leaderboard: leaderboard });
});

// Submit chat message for trivia (from Streamerbot or manual)
app.post('/api/trivia/chat', (req, res) => {
  const { user, message, timestamp } = req.body;

  if (!triviaState.active || !triviaState.currentQuestion) {
    return res.json({ stored: false });
  }

  const chatMsg = {
    id: Date.now(),
    user: user,
    message: message,
    timestamp: timestamp || new Date().toISOString(),
    processed: false,
    matchedAnswer: null
  };

  triviaChatBuffer.push(chatMsg);

  // Keep buffer to last 100 messages
  if (triviaChatBuffer.length > 100) {
    triviaChatBuffer = triviaChatBuffer.slice(-100);
  }

  // Broadcast to companion app
  broadcastToClients({
    type: 'trivia-chat',
    data: chatMsg
  });

  res.json({ stored: true, id: chatMsg.id });
});

// Get chat buffer
app.get('/api/trivia/chat', (req, res) => {
  res.json(triviaChatBuffer);
});

// Clear chat buffer (for new question)
app.post('/api/trivia/chat/clear', (req, res) => {
  triviaChatBuffer = [];
  res.json({ success: true });
});

// Manually award an answer to a user (override any existing)
app.post('/api/trivia/award', (req, res) => {
  const { answerIndex, user, chatMessageId } = req.body;

  console.log('Award request received:', { answerIndex, user, chatMessageId });

  if (!triviaState.active || !triviaState.currentQuestion) {
    return res.status(400).json({ error: 'No active question' });
  }

  const answers = triviaState.currentQuestion.answers;
  console.log('Current answers:', answers.map((a, i) => ({ index: i, text: a.text, points: a.points, revealed: a.revealed })));

  if (answerIndex < 0 || answerIndex >= answers.length) {
    return res.status(400).json({ error: 'Invalid answer index' });
  }

  const answer = answers[answerIndex];
  console.log('Awarding answer:', { index: answerIndex, text: answer.text, points: answer.points });

  // If this answer was already awarded to someone else, remove their points
  if (answer.revealed && answer.answeredBy && answer.answeredBy !== user) {
    const previousUser = answer.answeredBy;
    if (triviaState.players[previousUser]) {
      triviaState.players[previousUser].points -= answer.points;
      triviaState.players[previousUser].correctAnswers--;
      if (triviaState.players[previousUser].points <= 0 && triviaState.players[previousUser].correctAnswers <= 0) {
        delete triviaState.players[previousUser];
      }
    }
  }

  // Award to the new user
  if (!triviaState.players[user]) {
    triviaState.players[user] = { points: 0, correctAnswers: 0 };
  }

  // Only add points if this is a new award or reassignment
  if (!answer.revealed || answer.answeredBy !== user) {
    triviaState.players[user].points += answer.points;
    triviaState.players[user].correctAnswers++;
  }

  // Mark the answer as revealed
  answer.revealed = true;
  answer.answeredBy = user;
  answer.awardedManually = true;

  if (!triviaState.answersRevealed.includes(answerIndex)) {
    triviaState.answersRevealed.push(answerIndex);
  }

  // Mark the chat message as processed if provided
  if (chatMessageId) {
    const chatMsg = triviaChatBuffer.find(m => m.id === chatMessageId);
    if (chatMsg) {
      chatMsg.processed = true;
      chatMsg.matchedAnswer = answerIndex;
    }
  }

  // Broadcast the reveal
  broadcastToClients({
    type: 'trivia-answer-reveal',
    data: {
      index: answerIndex,
      text: answer.text,
      points: answer.points,
      user: user,
      chatMessageId: chatMessageId,
      manual: true,
      allRevealed: triviaState.answersRevealed.length === answers.length
    }
  });

  res.json({
    success: true,
    answer: {
      index: answerIndex,
      text: answer.text,
      points: answer.points,
      user: user
    }
  });
});

// ========== MOVIE GAME ENDPOINTS ==========

// Get available movies
app.get('/api/movies/available', (req, res) => {
  try {
    if (!fs.existsSync(CONFIG.moviesDir)) {
      fs.mkdirSync(CONFIG.moviesDir, { recursive: true });
    }
    const files = fs.readdirSync(CONFIG.moviesDir)
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
    res.json({
      count: files.length,
      movies: files.map(f => f.replace(/\.[^.]+$/, '')),
      path: CONFIG.moviesDir
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get movie game state
app.get('/api/movies/state', (req, res) => {
  res.json(movieState);
});

// Start movie game
app.post('/api/movies/start', (req, res) => {
  const { maxMovies = 5, totalGameTime = 180, pointsPerMovie = 500 } = req.body;

  try {
    if (!fs.existsSync(CONFIG.moviesDir)) {
      return res.status(400).json({ error: 'Movies directory not found' });
    }

    const files = fs.readdirSync(CONFIG.moviesDir)
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));

    if (files.length === 0) {
      return res.status(400).json({ error: 'No movie images found. Add images to: ' + CONFIG.moviesDir });
    }

    const actualMaxMovies = Math.min(maxMovies, files.length);
    const timePerMovie = Math.floor(totalGameTime / actualMaxMovies);

    movieState = {
      active: true,
      currentMovie: null,
      revealLevel: 0,
      answered: false,
      answeredBy: null,
      players: {},
      movieCount: 0,
      maxMovies: actualMaxMovies,
      usedMovies: [],
      availableMovies: files,
      revealInterval: null,
      pointsPerMovie: pointsPerMovie,
      totalGameTime: totalGameTime,
      timePerMovie: timePerMovie,
      movieStartTime: null,
      timeRemaining: timePerMovie,
      tileRevealOrder: []
    };

    movieChatBuffer = [];

    broadcastToClients({
      type: 'movie-started',
      data: { maxMovies: movieState.maxMovies, timePerMovie: timePerMovie }
    });

    res.json({ success: true, totalMovies: files.length, maxMovies: movieState.maxMovies, timePerMovie: timePerMovie });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Show intro screen for movie game
app.post('/api/movies/intro', (req, res) => {
  if (!movieState.active) {
    return res.status(400).json({ error: 'No active movie game' });
  }

  broadcastToClients({
    type: 'movie-intro',
    data: {
      maxMovies: movieState.maxMovies,
      pointsPerMovie: movieState.pointsPerMovie,
      timePerMovie: movieState.timePerMovie
    }
  });

  res.json({ success: true });
});

// Helper: Generate shuffled array of tile indices for random reveal
function generateTileRevealOrder(totalTiles = 40) {
  const indices = Array.from({ length: totalTiles }, (_, i) => i);
  // Fisher-Yates shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

// Next movie
app.post('/api/movies/next', (req, res) => {
  if (!movieState.active) {
    return res.status(400).json({ error: 'No active movie game' });
  }

  if (movieState.movieCount >= movieState.maxMovies) {
    return res.status(400).json({ error: 'Max movies reached' });
  }

  // Clear any existing reveal interval
  if (movieState.revealInterval) {
    clearInterval(movieState.revealInterval);
  }

  // Pick random unused movie
  const availableFiles = movieState.availableMovies.filter(
    f => !movieState.usedMovies.includes(f)
  );

  if (availableFiles.length === 0) {
    return res.status(400).json({ error: 'No more movies available' });
  }

  const randomFile = availableFiles[Math.floor(Math.random() * availableFiles.length)];
  const movieName = randomFile.replace(/\.[^.]+$/, ''); // Remove extension

  movieState.currentMovie = {
    file: randomFile,
    name: movieName,
    path: `/media/Games/Movies/${randomFile}`
  };
  movieState.revealLevel = 0;
  movieState.answered = false;
  movieState.answeredBy = null;
  movieState.usedMovies.push(randomFile);
  movieState.movieCount++;
  movieState.movieStartTime = Date.now();
  movieState.timeRemaining = movieState.timePerMovie;
  movieState.tileRevealOrder = generateTileRevealOrder(40);

  movieChatBuffer = [];

  // Broadcast to overlay with tile reveal order
  broadcastToClients({
    type: 'movie-question',
    data: {
      movieNumber: movieState.movieCount,
      maxMovies: movieState.maxMovies,
      imagePath: movieState.currentMovie.path,
      revealLevel: 0,
      timePerMovie: movieState.timePerMovie,
      timeRemaining: movieState.timePerMovie,
      pointsAvailable: movieState.pointsPerMovie,
      tileRevealOrder: movieState.tileRevealOrder
    }
  });

  // Timer-based reveal: update every second for stable display
  const updateInterval = 1000; // 1 second
  let elapsedSeconds = 0;

  movieState.revealInterval = setInterval(() => {
    if (!movieState.active || movieState.answered) {
      clearInterval(movieState.revealInterval);
      return;
    }

    elapsedSeconds++;

    // Calculate reveal level based on time (0-100)
    movieState.revealLevel = Math.min(100, (elapsedSeconds / movieState.timePerMovie) * 100);
    movieState.timeRemaining = Math.max(0, movieState.timePerMovie - elapsedSeconds);

    // Calculate current points available
    const pointsAvailable = Math.round(movieState.pointsPerMovie * (movieState.timeRemaining / movieState.timePerMovie));

    broadcastToClients({
      type: 'movie-reveal',
      data: {
        revealLevel: movieState.revealLevel,
        timeRemaining: movieState.timeRemaining,
        pointsAvailable: pointsAvailable
      }
    });

    // Time's up - no one got it
    if (movieState.timeRemaining <= 0) {
      clearInterval(movieState.revealInterval);
      broadcastToClients({
        type: 'movie-timeout',
        data: {
          movieName: movieState.currentMovie.name,
          revealLevel: 100
        }
      });
    }
  }, updateInterval);

  // Return full movie info to companion app
  res.json({
    success: true,
    movie: {
      name: movieName,
      file: randomFile,
      number: movieState.movieCount,
      maxMovies: movieState.maxMovies,
      timePerMovie: movieState.timePerMovie
    }
  });
});

// Check movie answer
app.post('/api/movies/check-answer', (req, res) => {
  const { answer, user } = req.body;

  if (!movieState.active || !movieState.currentMovie) {
    return res.json({ correct: false });
  }

  // Store in chat buffer
  const chatMsg = {
    id: Date.now(),
    user: user,
    message: answer,
    timestamp: new Date().toISOString()
  };
  movieChatBuffer.push(chatMsg);

  // Broadcast chat message
  broadcastToClients({
    type: 'movie-chat',
    data: chatMsg
  });

  // Already answered
  if (movieState.answered) {
    return res.json({ correct: false, alreadyAnswered: true });
  }

  // Check answer (case insensitive, partial match)
  const normalizedAnswer = answer.toLowerCase().trim();
  const movieName = movieState.currentMovie.name.toLowerCase().trim();

  // Check for match (exact or close enough)
  const isCorrect = movieName === normalizedAnswer ||
    movieName.includes(normalizedAnswer) ||
    normalizedAnswer.includes(movieName) ||
    // Remove common words and check
    movieName.replace(/^(the|a|an)\s+/i, '') === normalizedAnswer.replace(/^(the|a|an)\s+/i, '');

  if (isCorrect) {
    // Stop reveal
    if (movieState.revealInterval) {
      clearInterval(movieState.revealInterval);
    }

    movieState.answered = true;
    movieState.answeredBy = user;

    // Calculate points based on time remaining (more time = more points)
    const points = Math.max(10, Math.round(movieState.pointsPerMovie * (movieState.timeRemaining / movieState.timePerMovie)));

    // Award points
    if (!movieState.players[user]) {
      movieState.players[user] = { points: 0, correctAnswers: 0 };
    }
    movieState.players[user].points += points;
    movieState.players[user].correctAnswers++;

    // Broadcast correct answer
    broadcastToClients({
      type: 'movie-correct',
      data: {
        user: user,
        movieName: movieState.currentMovie.name,
        points: points,
        timeRemaining: movieState.timeRemaining,
        chatMessageId: chatMsg.id
      }
    });

    return res.json({
      correct: true,
      movieName: movieState.currentMovie.name,
      points: points,
      timeRemaining: movieState.timeRemaining
    });
  }

  res.json({ correct: false });
});

// Manually reveal movie (skip)
app.post('/api/movies/reveal', (req, res) => {
  if (!movieState.active || !movieState.currentMovie) {
    return res.status(400).json({ error: 'No active movie' });
  }

  if (movieState.revealInterval) {
    clearInterval(movieState.revealInterval);
  }

  movieState.revealLevel = 100;
  movieState.answered = true; // Mark as done

  broadcastToClients({
    type: 'movie-timeout',
    data: {
      movieName: movieState.currentMovie.name,
      revealLevel: 100,
      skipped: true
    }
  });

  res.json({ success: true, movieName: movieState.currentMovie.name });
});

// End movie game
app.post('/api/movies/end', (req, res) => {
  if (movieState.revealInterval) {
    clearInterval(movieState.revealInterval);
  }

  const leaderboard = Object.entries(movieState.players)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.points - a.points);

  // Award cumulative stats
  if (!db.gameStats) {
    db.gameStats = {
      players: {},
      placementPoints: { first: 3, second: 2, third: 1 },
      history: [],
      periodStart: new Date().toISOString()
    };
  }

  const placementPoints = db.gameStats.placementPoints;

  leaderboard.forEach((player, index) => {
    const username = player.name;

    if (!db.gameStats.players[username]) {
      db.gameStats.players[username] = {
        totalPoints: 0,
        wins: 0,
        secondPlace: 0,
        thirdPlace: 0,
        gamesPlayed: 0,
        lastPlayed: null
      };
    }

    const stats = db.gameStats.players[username];
    stats.gamesPlayed++;
    stats.lastPlayed = new Date().toISOString();

    if (index === 0) {
      stats.wins++;
      stats.totalPoints += placementPoints.first;
    } else if (index === 1) {
      stats.secondPlace++;
      stats.totalPoints += placementPoints.second;
    } else if (index === 2) {
      stats.thirdPlace++;
      stats.totalPoints += placementPoints.third;
    }
  });

  // Save to history
  db.gameStats.history.push({
    date: new Date().toISOString(),
    gameType: 'movie',
    movieCount: movieState.movieCount,
    leaderboard: leaderboard.slice(0, 10).map(p => ({
      name: p.name,
      points: p.points,
      correctAnswers: p.correctAnswers
    }))
  });

  if (db.gameStats.history.length > 100) {
    db.gameStats.history = db.gameStats.history.slice(-100);
  }

  saveDB(db);

  broadcastToClients({
    type: 'movie-ended',
    data: { leaderboard: leaderboard }
  });

  movieState.active = false;
  movieChatBuffer = [];

  res.json({ success: true, leaderboard: leaderboard });
});

// Get movie chat buffer
app.get('/api/movies/chat', (req, res) => {
  res.json(movieChatBuffer);
});

// ========== CUMULATIVE GAME STATS ENDPOINTS ==========

// Get cumulative leaderboard
app.get('/api/games/leaderboard', (req, res) => {
  if (!db.gameStats || !db.gameStats.players) {
    return res.json({ players: [], periodStart: null });
  }

  const leaderboard = Object.entries(db.gameStats.players)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.totalPoints - a.totalPoints);

  res.json({
    players: leaderboard,
    periodStart: db.gameStats.periodStart,
    placementPoints: db.gameStats.placementPoints,
    totalGames: db.gameStats.history ? db.gameStats.history.length : 0
  });
});

// Get/set placement points
app.get('/api/games/placement-points', (req, res) => {
  if (!db.gameStats) {
    db.gameStats = {
      players: {},
      placementPoints: { first: 3, second: 2, third: 1 },
      history: [],
      periodStart: new Date().toISOString()
    };
  }
  res.json(db.gameStats.placementPoints);
});

app.post('/api/games/placement-points', (req, res) => {
  const { first, second, third } = req.body;

  if (!db.gameStats) {
    db.gameStats = {
      players: {},
      placementPoints: { first: 3, second: 2, third: 1 },
      history: [],
      periodStart: new Date().toISOString()
    };
  }

  db.gameStats.placementPoints = {
    first: parseInt(first) || 3,
    second: parseInt(second) || 2,
    third: parseInt(third) || 1
  };

  saveDB(db);
  res.json({ success: true, placementPoints: db.gameStats.placementPoints });
});

// Get game history
app.get('/api/games/history', (req, res) => {
  if (!db.gameStats || !db.gameStats.history) {
    return res.json({ history: [] });
  }
  res.json({ history: db.gameStats.history });
});

// Reset period (start fresh for new prize period)
app.post('/api/games/reset-period', (req, res) => {
  const { keepHistory = false } = req.body;

  // Archive current stats if needed
  const previousStats = db.gameStats ? { ...db.gameStats } : null;

  db.gameStats = {
    players: {},
    placementPoints: db.gameStats?.placementPoints || { first: 3, second: 2, third: 1 },
    history: keepHistory ? (db.gameStats?.history || []) : [],
    periodStart: new Date().toISOString()
  };

  saveDB(db);
  res.json({
    success: true,
    message: 'Period reset successfully',
    previousStats: previousStats
  });
});

// Export stats as JSON (for backup/prizes)
app.get('/api/games/export', (req, res) => {
  if (!db.gameStats) {
    return res.json({ error: 'No game stats available' });
  }

  const exportData = {
    exportDate: new Date().toISOString(),
    periodStart: db.gameStats.periodStart,
    placementPoints: db.gameStats.placementPoints,
    leaderboard: Object.entries(db.gameStats.players)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.totalPoints - a.totalPoints),
    totalGames: db.gameStats.history?.length || 0,
    recentGames: db.gameStats.history?.slice(-10) || []
  };

  res.json(exportData);
});

// Delete a specific player from stats
app.delete('/api/games/player/:name', (req, res) => {
  const playerName = req.params.name;

  if (!db.gameStats || !db.gameStats.players[playerName]) {
    return res.status(404).json({ error: 'Player not found' });
  }

  delete db.gameStats.players[playerName];
  saveDB(db);
  res.json({ success: true, message: `Player ${playerName} removed` });
});

// ========== DBD CHALLENGE ENDPOINTS ==========

// Initialize DBD challenge from database or create fresh
function loadDbdChallenge() {
  if (db.dbdChallenge) {
    dbdChallengeState = { ...dbdChallengeState, ...db.dbdChallenge };
    return;
  }
  if (db.dbdChallengeConfig) {
    dbdChallengeConfig = { ...dbdChallengeConfig, ...db.dbdChallengeConfig };
  }
  // Initialize fresh challenge
  initializeDbdChallenge(false);
}

function loadDbdConfig() {
  if (db.dbdChallengeConfig) {
    dbdChallengeConfig = { ...dbdChallengeConfig, ...db.dbdChallengeConfig };
  }
}

function saveDbdConfig() {
  db.dbdChallengeConfig = dbdChallengeConfig;
  saveDB(db);
}

// Randomize killers across tiers (Free tier stays fixed)
function randomizeKillerTiers(config) {
  const { distribution } = config;

  // Free tier killers are always Trapper and Skull Merchant
  const freeKillers = ['Trapper', 'Skull Merchant'];

  // Get all other killers to randomize
  const otherKillers = FULL_KILLER_ROSTER.filter(k => !freeKillers.includes(k));
  const shuffled = shuffleArray([...otherKillers]);

  // Build tiers based on distribution
  const tiers = {
    free: { name: 'Free', cost: config.tierCosts.free, killers: [...freeKillers] }
  };

  let index = 0;
  const tierOrder = ['ash', 'bronze', 'silver', 'gold', 'iri'];
  const tierNames = { ash: 'Ash', bronze: 'Bronze', silver: 'Silver', gold: 'Gold', iri: 'Iridescent' };

  tierOrder.forEach(tierKey => {
    const count = distribution[tierKey];
    tiers[tierKey] = {
      name: tierNames[tierKey],
      cost: config.tierCosts[tierKey],
      killers: shuffled.slice(index, index + count)
    };
    index += count;
  });

  return tiers;
}

// Use standard tier placement (no randomization)
function getStandardTiers(config) {
  const tiers = JSON.parse(JSON.stringify(DEFAULT_TIER_CONFIG));

  // Apply custom costs from config
  Object.keys(tiers).forEach(tierKey => {
    tiers[tierKey].cost = config.tierCosts[tierKey];
  });

  return tiers;
}

function initializeDbdChallenge(randomize = false, config = null) {
  const useConfig = config || dbdChallengeConfig;
  const killers = {};

  // Get tiers (randomized or standard)
  const tiers = randomize ? randomizeKillerTiers(useConfig) : getStandardTiers(useConfig);

  // Initialize each killer
  Object.keys(tiers).forEach(tierKey => {
    tiers[tierKey].killers.forEach(killerName => {
      killers[killerName] = {
        tier: tierKey,
        played: false,
        kills: 0,
        threeK: false,
        fourK: false,
        pips: 0,
        pointsEarned: 0,
        pointsSpent: 0
      };
    });
  });

  // Calculate metrics
  const metrics = calculateChallengeMetrics(useConfig);

  dbdChallengeState = {
    active: false,
    season: db.dbdChallenge?.season || 1,
    challengeType: 'killer',
    currentPoints: useConfig.startingPoints,
    gamesPlayed: 0,
    currentPips: 0,
    pipGoal: useConfig.pipGoal,
    gameGoal: metrics.totalKillers,
    killers: killers,
    tiers: tiers,
    history: [],
    currentKiller: null,
    startedAt: null,
    config: useConfig,
    metrics: metrics
  };
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function saveDbdChallenge() {
  db.dbdChallenge = dbdChallengeState;
  saveDB(db);
}

// Get full killer roster
app.get('/api/dbd/roster', (req, res) => {
  res.json({
    killers: FULL_KILLER_ROSTER,
    total: FULL_KILLER_ROSTER.length,
    defaultTiers: DEFAULT_TIER_CONFIG
  });
});

// Get difficulty presets
app.get('/api/dbd/presets', (req, res) => {
  const presetsWithMetrics = {};
  Object.keys(DIFFICULTY_PRESETS).forEach(key => {
    const preset = DIFFICULTY_PRESETS[key];
    presetsWithMetrics[key] = {
      ...preset,
      metrics: calculateChallengeMetrics(preset)
    };
  });
  res.json(presetsWithMetrics);
});

// Get current configuration
app.get('/api/dbd/config', (req, res) => {
  loadDbdConfig();
  res.json({
    config: dbdChallengeConfig,
    metrics: calculateChallengeMetrics(dbdChallengeConfig)
  });
});

// Get available challenge types
app.get('/api/dbd/challenge-types', (req, res) => {
  res.json(DBD_CHALLENGE_TYPES);
});

// Update configuration
app.post('/api/dbd/config', (req, res) => {
  const { preset, startingPoints, tierCosts, distribution, challengeType } = req.body;

  // If using a preset, apply it
  if (preset && DIFFICULTY_PRESETS[preset]) {
    const presetConfig = DIFFICULTY_PRESETS[preset];
    dbdChallengeConfig = {
      challengeType: challengeType || dbdChallengeConfig.challengeType,
      preset,
      startingPoints: presetConfig.startingPoints,
      tierCosts: { ...presetConfig.tierCosts },
      distribution: { ...presetConfig.distribution }
    };
  } else {
    // Custom configuration
    dbdChallengeConfig = {
      challengeType: challengeType || dbdChallengeConfig.challengeType,
      preset: 'custom',
      startingPoints: startingPoints ?? dbdChallengeConfig.startingPoints,
      tierCosts: tierCosts ? { ...dbdChallengeConfig.tierCosts, ...tierCosts } : dbdChallengeConfig.tierCosts,
      distribution: distribution ? { ...dbdChallengeConfig.distribution, ...distribution } : dbdChallengeConfig.distribution
    };
  }

  // Validate distribution adds up to total killers (minus 2 for Free tier)
  const totalDistributed = Object.values(dbdChallengeConfig.distribution).reduce((a, b) => a + b, 0);
  if (totalDistributed !== FULL_KILLER_ROSTER.length) {
    return res.status(400).json({
      error: `Distribution must total ${FULL_KILLER_ROSTER.length} killers. Currently: ${totalDistributed}`
    });
  }

  saveDbdConfig();

  res.json({
    success: true,
    config: dbdChallengeConfig,
    metrics: calculateChallengeMetrics(dbdChallengeConfig)
  });
});

// Preview randomized tiers without starting
app.post('/api/dbd/preview-randomize', (req, res) => {
  loadDbdConfig();
  const config = req.body.config || dbdChallengeConfig;
  const tiers = randomizeKillerTiers(config);
  const metrics = calculateChallengeMetrics(config);

  res.json({ tiers, metrics, config });
});

// Get current DBD challenge state
app.get('/api/dbd/state', (req, res) => {
  loadDbdChallenge();
  res.json(dbdChallengeState);
});

// Start a new DBD challenge
app.post('/api/dbd/start', (req, res) => {
  const { season, randomize = true, useCurrentConfig = true } = req.body;

  // Load current config
  loadDbdConfig();

  // Initialize with randomization option
  initializeDbdChallenge(randomize, dbdChallengeConfig);

  dbdChallengeState.active = true;
  dbdChallengeState.season = season || (db.dbdChallenge?.season || 0) + 1;
  dbdChallengeState.startedAt = new Date().toISOString();

  saveDbdChallenge();

  broadcastToClients({
    type: 'dbd-challenge-started',
    data: dbdChallengeState
  });

  res.json({ success: true, state: dbdChallengeState });
});

// Select a killer to play
app.post('/api/dbd/select-killer', (req, res) => {
  const { killerName } = req.body;

  if (!dbdChallengeState.active) {
    return res.status(400).json({ error: 'No active challenge' });
  }

  const killer = dbdChallengeState.killers[killerName];
  if (!killer) {
    return res.status(404).json({ error: 'Killer not found' });
  }

  if (killer.played) {
    return res.status(400).json({ error: 'Killer already played this challenge' });
  }

  const tier = dbdChallengeState.tiers[killer.tier];
  const cost = tier.cost;

  // Check if player has enough points (free tier costs 0)
  if (dbdChallengeState.currentPoints < cost && cost > 0) {
    return res.status(400).json({ error: `Not enough points. Need ${cost}, have ${dbdChallengeState.currentPoints}` });
  }

  // Deduct points for selecting this killer
  dbdChallengeState.currentPoints -= cost;
  killer.pointsSpent = cost;
  dbdChallengeState.currentKiller = killerName;

  saveDbdChallenge();

  broadcastToClients({
    type: 'dbd-killer-selected',
    data: {
      killer: killerName,
      tier: killer.tier,
      cost: cost,
      currentPoints: dbdChallengeState.currentPoints
    }
  });

  res.json({
    success: true,
    killer: killerName,
    tier: killer.tier,
    cost: cost,
    currentPoints: dbdChallengeState.currentPoints
  });
});

// Record game result
app.post('/api/dbd/record-game', (req, res) => {
  const { killerName, kills } = req.body;

  if (!dbdChallengeState.active) {
    return res.status(400).json({ error: 'No active challenge' });
  }

  const actualKillerName = killerName || dbdChallengeState.currentKiller;
  const killer = dbdChallengeState.killers[actualKillerName];
  if (!killer) {
    return res.status(404).json({ error: 'Killer not found' });
  }

  // Update killer stats
  killer.played = true;
  killer.kills = kills;
  killer.threeK = kills >= 3;
  killer.fourK = kills >= 4;

  // Calculate points earned (1 per kill, max 4)
  const pointsEarned = Math.min(kills, 4);
  killer.pointsEarned = pointsEarned;

  // Update challenge totals
  dbdChallengeState.currentPoints += pointsEarned;
  dbdChallengeState.gamesPlayed++;
  dbdChallengeState.totalKills += kills;

  // Record in history
  dbdChallengeState.history.push({
    killer: actualKillerName,
    kills,
    pointsEarned,
    pointsSpent: killer.pointsSpent,
    totalPoints: dbdChallengeState.currentPoints,
    timestamp: new Date().toISOString()
  });

  // Check completion status
  const allKillersPlayed = Object.values(dbdChallengeState.killers).every(k => k.played);
  const runFailed = dbdChallengeState.currentPoints <= 0 && !allKillersPlayed;
  const runCompleted = allKillersPlayed && dbdChallengeState.currentPoints > 0;

  dbdChallengeState.currentKiller = null;

  saveDbdChallenge();

  broadcastToClients({
    type: 'dbd-game-recorded',
    data: {
      killer: actualKillerName,
      kills,
      pointsEarned,
      currentPoints: dbdChallengeState.currentPoints,
      gamesPlayed: dbdChallengeState.gamesPlayed,
      totalKills: dbdChallengeState.totalKills,
      runFailed,
      runCompleted,
      allKillersPlayed
    }
  });

  res.json({
    success: true,
    pointsEarned,
    currentPoints: dbdChallengeState.currentPoints,
    gamesPlayed: dbdChallengeState.gamesPlayed,
    totalKills: dbdChallengeState.totalKills,
    runFailed,
    runCompleted,
    allKillersPlayed
  });
});

// Promote killer to free tier (reward for completing a run)
app.post('/api/dbd/promote-to-free', (req, res) => {
  const { killerName } = req.body;

  // Check if run was completed successfully
  const allKillersPlayed = Object.values(dbdChallengeState.killers).every(k => k.played);
  if (!allKillersPlayed) {
    return res.status(400).json({ error: 'Must complete a run before promoting a killer' });
  }

  // Check if killer exists and isn't already in free tier
  if (dbdChallengeState.freePoolKillers.includes(killerName)) {
    return res.status(400).json({ error: 'Killer is already in the free pool' });
  }

  if (!FULL_KILLER_ROSTER.includes(killerName)) {
    return res.status(404).json({ error: 'Killer not found' });
  }

  // Add to permanent free pool
  dbdChallengeState.freePoolKillers.push(killerName);

  // Save the run to season history
  dbdChallengeState.seasonHistory.push({
    runNumber: dbdChallengeState.runNumber,
    gamesPlayed: dbdChallengeState.gamesPlayed,
    totalKills: dbdChallengeState.totalKills,
    finalPoints: dbdChallengeState.currentPoints,
    killerPromoted: killerName,
    completedAt: new Date().toISOString()
  });

  saveDbdChallenge();

  broadcastToClients({
    type: 'dbd-killer-promoted',
    data: {
      killer: killerName,
      freePoolSize: dbdChallengeState.freePoolKillers.length,
      totalKillers: FULL_KILLER_ROSTER.length
    }
  });

  res.json({
    success: true,
    killer: killerName,
    freePoolKillers: dbdChallengeState.freePoolKillers,
    freePoolSize: dbdChallengeState.freePoolKillers.length
  });
});

// Start a new run (after completion or failure)
app.post('/api/dbd/new-run', (req, res) => {
  const { randomize = true } = req.body;

  // Preserve important state
  const currentSeason = dbdChallengeState.season;
  const currentRunNumber = dbdChallengeState.runNumber || 1;
  const freePoolKillers = dbdChallengeState.freePoolKillers || ['Trapper', 'Skull Merchant'];
  const seasonHistory = dbdChallengeState.seasonHistory || [];

  // Initialize new run
  initializeDbdChallenge(randomize);

  // Restore preserved state
  dbdChallengeState.season = currentSeason;
  dbdChallengeState.runNumber = currentRunNumber + 1;
  dbdChallengeState.freePoolKillers = freePoolKillers;
  dbdChallengeState.seasonHistory = seasonHistory;
  dbdChallengeState.active = true;
  dbdChallengeState.startedAt = new Date().toISOString();

  // Update free tier with all permanently free killers
  dbdChallengeState.tiers.free.killers = [...freePoolKillers];
  freePoolKillers.forEach(k => {
    if (dbdChallengeState.killers[k]) {
      dbdChallengeState.killers[k].tier = 'free';
    }
  });

  saveDbdChallenge();

  broadcastToClients({
    type: 'dbd-new-run',
    data: dbdChallengeState
  });

  res.json({ success: true, state: dbdChallengeState });
});

// Reset challenge (legacy - keep for compatibility)
app.post('/api/dbd/reset', (req, res) => {
  const { randomize = true } = req.body;

  // Preserve free pool
  const freePoolKillers = dbdChallengeState.freePoolKillers || ['Trapper', 'Skull Merchant'];
  const seasonHistory = dbdChallengeState.seasonHistory || [];
  const currentSeason = dbdChallengeState.season;
  const currentRunNumber = dbdChallengeState.runNumber || 1;

  initializeDbdChallenge(randomize);

  dbdChallengeState.season = currentSeason;
  dbdChallengeState.runNumber = currentRunNumber + 1;
  dbdChallengeState.freePoolKillers = freePoolKillers;
  dbdChallengeState.seasonHistory = seasonHistory;
  dbdChallengeState.active = true;
  dbdChallengeState.startedAt = new Date().toISOString();

  saveDbdChallenge();

  broadcastToClients({
    type: 'dbd-challenge-reset',
    data: dbdChallengeState
  });

  res.json({ success: true, state: dbdChallengeState });
});

// End challenge
app.post('/api/dbd/end', (req, res) => {
  dbdChallengeState.active = false;
  saveDbdChallenge();

  broadcastToClients({
    type: 'dbd-challenge-ended',
    data: dbdChallengeState
  });

  res.json({ success: true, finalState: dbdChallengeState });
});

// Update challenge settings
app.post('/api/dbd/settings', (req, res) => {
  const { pipGoal, gameGoal, startingPoints } = req.body;

  if (pipGoal !== undefined) dbdChallengeState.pipGoal = pipGoal;
  if (gameGoal !== undefined) dbdChallengeState.gameGoal = gameGoal;
  if (startingPoints !== undefined && !dbdChallengeState.active) {
    dbdChallengeState.currentPoints = startingPoints;
  }

  saveDbdChallenge();
  res.json({ success: true, state: dbdChallengeState });
});

// Get available killers (not played yet)
app.get('/api/dbd/available-killers', (req, res) => {
  const available = {};

  Object.keys(dbdChallengeState.tiers).forEach(tierKey => {
    const tier = dbdChallengeState.tiers[tierKey];
    available[tierKey] = {
      name: tier.name,
      cost: tier.cost,
      killers: tier.killers.filter(k => !dbdChallengeState.killers[k]?.played)
    };
  });

  res.json(available);
});

// Get challenge history
app.get('/api/dbd/history', (req, res) => {
  res.json(dbdChallengeState.history);
});

// Random killer selection with animation
app.post('/api/dbd/random-killer', async (req, res) => {
  if (!dbdChallengeState.active) {
    return res.status(400).json({ error: 'No active challenge' });
  }

  // Get all available (unplayed) killers the player can afford
  const availableKillers = [];
  Object.entries(dbdChallengeState.killers).forEach(([name, killer]) => {
    if (killer.played) return;
    const tier = dbdChallengeState.tiers[killer.tier];
    if (dbdChallengeState.currentPoints >= tier.cost) {
      availableKillers.push({ name, tier: killer.tier, cost: tier.cost });
    }
  });

  if (availableKillers.length === 0) {
    return res.status(400).json({ error: 'No affordable killers available' });
  }

  // Pick a random killer
  const selected = availableKillers[Math.floor(Math.random() * availableKillers.length)];

  // Build list for animation (shuffle order)
  const animationKillers = availableKillers
    .map(k => k.name)
    .sort(() => Math.random() - 0.5);

  // Broadcast animation start
  broadcastToClients({
    type: 'dbd-randomize-start',
    data: {
      killers: animationKillers,
      selectedKiller: selected.name,
      duration: 4000 // 4 seconds of spinning
    }
  });

  // Wait for animation, then select the killer
  setTimeout(async () => {
    // Deduct points
    dbdChallengeState.currentPoints -= selected.cost;
    const killer = dbdChallengeState.killers[selected.name];
    killer.pointsSpent = selected.cost;
    dbdChallengeState.currentKiller = selected.name;

    saveDbdChallenge();

    // Broadcast selection
    broadcastToClients({
      type: 'dbd-killer-selected',
      data: {
        killer: selected.name,
        tier: selected.tier,
        cost: selected.cost,
        currentPoints: dbdChallengeState.currentPoints
      }
    });
  }, 4500); // After animation completes

  res.json({
    success: true,
    selectedKiller: selected.name,
    tier: selected.tier,
    cost: selected.cost,
    animationDuration: 4000
  });
});

// Add new killer to the game
app.post('/api/dbd/add-killer', (req, res) => {
  const { killerName, tier } = req.body;

  if (!killerName || !tier) {
    return res.status(400).json({ error: 'Killer name and tier required' });
  }

  if (!dbdChallengeState.tiers[tier]) {
    return res.status(400).json({ error: 'Invalid tier' });
  }

  if (dbdChallengeState.killers[killerName]) {
    return res.status(400).json({ error: 'Killer already exists' });
  }

  // Add killer to tier
  dbdChallengeState.tiers[tier].killers.push(killerName);
  dbdChallengeState.killers[killerName] = {
    tier: tier,
    played: false,
    kills: 0,
    threeK: false,
    fourK: false,
    pips: 0,
    pointsEarned: 0,
    pointsSpent: 0
  };

  saveDbdChallenge();

  res.json({ success: true, killer: killerName, tier: tier });
});

// Initialize DBD challenge on startup
loadDbdChallenge();

// Load tracker settings from DB
if (db.dbdTracker) {
  dbdTrackerState.apiUrl = db.dbdTracker.apiUrl || null;
  dbdTrackerState.lastExternalId = db.dbdTracker.lastExternalId || null;
  dbdTrackerState.autoPolling = db.dbdTracker.autoPolling || false;
  dbdTrackerState.pendingMatch = db.dbdTracker.pendingMatch || null;
  if (db.dbdTracker.processedIds) {
    dbdTrackerState.processedIds = new Set(db.dbdTracker.processedIds);
  }
  // Auto-start polling if it was enabled and URL is configured
  if (dbdTrackerState.apiUrl && dbdTrackerState.autoPolling) {
    console.log('Resuming DBD Tracker auto-polling from saved settings');
    startTrackerPolling();
  }
}

// ========== DBD TRACKER API INTEGRATION ==========

// Helper: Normalize killer name (remove "The " prefix to match our data)
function normalizeKillerName(apiName) {
  if (!apiName) return null;
  // API returns "The Trapper", our data has "Trapper"
  return apiName.replace(/^The\s+/i, '').trim();
}

// Save tracker state to DB
function saveDbdTrackerState() {
  db.dbdTracker = {
    apiUrl: dbdTrackerState.apiUrl,
    lastExternalId: dbdTrackerState.lastExternalId,
    processedIds: Array.from(dbdTrackerState.processedIds).slice(-500), // Keep last 500 IDs
    autoPolling: dbdTrackerState.autoPolling,
    pendingMatch: dbdTrackerState.pendingMatch // Persist pending match
  };
  saveDB(db);
}

// Get tracker settings
app.get('/api/dbd/tracker/settings', (req, res) => {
  res.json({
    configured: !!dbdTrackerState.apiUrl,
    apiUrl: dbdTrackerState.apiUrl, // Return URL so renderer can show it (masked input)
    autoPolling: dbdTrackerState.autoPolling,
    lastCheck: dbdTrackerState.lastCheck,
    lastExternalId: dbdTrackerState.lastExternalId,
    pendingMatch: dbdTrackerState.pendingMatch
  });
});

// Set tracker API URL
app.post('/api/dbd/tracker/settings', (req, res) => {
  const { apiUrl, autoPolling } = req.body;

  if (apiUrl !== undefined) {
    // Validate URL format
    try {
      const url = new URL(apiUrl);
      if (!url.searchParams.get('key')) {
        return res.status(400).json({ error: 'URL must include ?key= parameter' });
      }
      dbdTrackerState.apiUrl = apiUrl;
      console.log('DBD Tracker API URL configured (key hidden)');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
  }

  if (autoPolling !== undefined) {
    dbdTrackerState.autoPolling = autoPolling;
    if (autoPolling && !dbdTrackerState.pollInterval) {
      startTrackerPolling();
    } else if (!autoPolling && dbdTrackerState.pollInterval) {
      stopTrackerPolling();
    }
  }

  saveDbdTrackerState();
  res.json({ success: true, configured: !!dbdTrackerState.apiUrl });
});

// Check for new matches from tracker
app.post('/api/dbd/tracker/check', async (req, res) => {
  if (!dbdTrackerState.apiUrl) {
    return res.status(400).json({ error: 'Tracker API not configured' });
  }

  try {
    const result = await fetchTrackerMatches();
    res.json(result);
  } catch (e) {
    console.error('Tracker check error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fetch matches from tracker API
async function fetchTrackerMatches() {
  let url = dbdTrackerState.apiUrl;

  // Add since parameter for incremental polling
  if (dbdTrackerState.lastExternalId) {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}since=${dbdTrackerState.lastExternalId}&limit=10`;
  } else {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}limit=5&side=killer`; // Only killer matches for challenge
  }

  const response = await fetch(url);
  dbdTrackerState.lastCheck = new Date().toISOString();

  if (response.status === 401) {
    throw new Error('Invalid or expired API key. Please re-enter your tracker URL.');
  }

  if (!response.ok) {
    throw new Error(`Tracker API error: ${response.status}`);
  }

  const data = await response.json();

  if (!data.ok || !data.matches) {
    return { newMatches: 0, matches: [] };
  }

  // Filter to killer matches only and dedupe
  const newMatches = [];
  // Process oldest first so IDs advance correctly
  for (const match of data.matches.slice().reverse()) {
    if (match.side !== 'KILLER') continue;
    if (dbdTrackerState.processedIds.has(match.externalId)) continue;

    // Don't auto-add to processedIds yet - wait until user confirms
    const normalizedKiller = normalizeKillerName(match.killerName);

    newMatches.push({
      externalId: match.externalId,
      killerName: normalizedKiller,
      killerNameRaw: match.killerName,
      kills: match.kills || 0,
      isWin: match.isWin,
      mapName: match.mapName,
      gameMode: match.gameMode,
      bloodpoints: match.bloodpoints,
      playedAt: match.playedAt
    });
  }

  // Store the most recent match as pending if there are new ones
  if (newMatches.length > 0) {
    dbdTrackerState.pendingMatch = newMatches[newMatches.length - 1];
    saveDbdTrackerState(); // Persist pending match

    broadcastToClients({
      type: 'dbd-tracker-match',
      data: dbdTrackerState.pendingMatch
    });
  }

  return {
    newMatches: newMatches.length,
    matches: newMatches,
    pendingMatch: dbdTrackerState.pendingMatch
  };
}

// Apply pending match to challenge (user confirms)
app.post('/api/dbd/tracker/apply', (req, res) => {
  const { externalId, killerName, kills } = req.body;

  // Check if this killer exists in our challenge BEFORE marking as processed
  if (!dbdChallengeState.active) {
    // Don't mark as processed - keep pending so user can apply after starting challenge
    return res.json({ success: true, applied: false, reason: 'No active challenge. Start a challenge first.' });
  }

  const killer = dbdChallengeState.killers[killerName];
  if (!killer) {
    // Don't mark as processed - user might add the killer
    return res.json({
      success: true,
      applied: false,
      reason: `Killer "${killerName}" not found in challenge. May need to add them.`,
      suggestAdd: true,
      killerName
    });
  }

  if (killer.played) {
    // This killer was already played - mark as processed to avoid showing again
    dbdTrackerState.processedIds.add(externalId);
    dbdTrackerState.lastExternalId = externalId;
    dbdTrackerState.pendingMatch = null;
    saveDbdTrackerState();
    return res.json({
      success: true,
      applied: false,
      reason: `${killerName} already played in this challenge.`
    });
  }

  // Auto-select and record in one step
  const tier = dbdChallengeState.tiers[killer.tier];
  const cost = tier.cost;

  // Check points
  if (dbdChallengeState.currentPoints < cost && cost > 0) {
    // Don't mark as processed - user might get more points later
    return res.json({
      success: true,
      applied: false,
      reason: `Not enough points for ${killerName}. Need ${cost}, have ${dbdChallengeState.currentPoints}`
    });
  }

  // Success - now mark as processed
  dbdTrackerState.processedIds.add(externalId);
  dbdTrackerState.lastExternalId = externalId;
  dbdTrackerState.pendingMatch = null;
  saveDbdTrackerState();

  // Deduct cost
  dbdChallengeState.currentPoints -= cost;
  killer.pointsSpent = cost;

  // Record game (kills only - no pips in Barebones challenge)
  killer.played = true;
  killer.kills = kills;
  killer.threeK = kills >= 3;
  killer.fourK = kills >= 4;

  const pointsEarned = Math.min(kills, 4); // Max 4 points per game
  killer.pointsEarned = pointsEarned;

  dbdChallengeState.currentPoints += pointsEarned;
  dbdChallengeState.gamesPlayed++;
  dbdChallengeState.totalKills = (dbdChallengeState.totalKills || 0) + kills;

  dbdChallengeState.history.push({
    killer: killerName,
    kills,
    pointsEarned,
    pointsSpent: cost,
    totalPoints: dbdChallengeState.currentPoints,
    timestamp: new Date().toISOString(),
    fromTracker: true,
    externalId
  });

  const allKillersPlayed = Object.values(dbdChallengeState.killers).every(k => k.played);
  const runFailed = dbdChallengeState.currentPoints <= 0 && !allKillersPlayed;

  saveDbdChallenge();

  broadcastToClients({
    type: 'dbd-game-recorded',
    data: {
      killer: killerName,
      kills,
      pointsEarned,
      currentPoints: dbdChallengeState.currentPoints,
      gamesPlayed: dbdChallengeState.gamesPlayed,
      totalKills: dbdChallengeState.totalKills,
      runFailed,
      allKillersPlayed,
      fromTracker: true
    }
  });

  res.json({
    success: true,
    applied: true,
    pointsEarned,
    pointsSpent: cost,
    netPoints: pointsEarned - cost,
    currentPoints: dbdChallengeState.currentPoints,
    runFailed,
    allKillersPlayed
  });
});

// Dismiss pending match without applying
app.post('/api/dbd/tracker/dismiss', (req, res) => {
  const { externalId } = req.body;

  if (externalId) {
    dbdTrackerState.processedIds.add(externalId);
    dbdTrackerState.lastExternalId = externalId;
  }
  dbdTrackerState.pendingMatch = null;
  saveDbdTrackerState();

  res.json({ success: true });
});

// Clear tracker configuration
app.post('/api/dbd/tracker/clear', (req, res) => {
  stopTrackerPolling();
  dbdTrackerState.apiUrl = null;
  dbdTrackerState.lastExternalId = null;
  dbdTrackerState.processedIds.clear();
  dbdTrackerState.pendingMatch = null;
  saveDbdTrackerState();

  res.json({ success: true });
});

// Background polling
function startTrackerPolling() {
  if (dbdTrackerState.pollInterval) return;

  console.log('Starting DBD Tracker background polling (60s interval)');
  dbdTrackerState.pollInterval = setInterval(async () => {
    if (!dbdTrackerState.apiUrl) return;

    try {
      await fetchTrackerMatches();
    } catch (e) {
      console.error('Background poll error:', e.message);
    }
  }, 60000); // 60 second interval
}

function stopTrackerPolling() {
  if (dbdTrackerState.pollInterval) {
    clearInterval(dbdTrackerState.pollInterval);
    dbdTrackerState.pollInterval = null;
    console.log('Stopped DBD Tracker background polling');
  }
}

// ========== TWITCH API ENDPOINTS ==========

// Get Twitch status
app.get('/api/twitch/status', (req, res) => {
  res.json({
    connected: twitchState.connected,
    channel: twitchState.channel,
    username: twitchState.username,
    userId: twitchState.userId
  });
});

// Get Twitch settings (without exposing tokens)
app.get('/api/twitch/settings', (req, res) => {
  const settings = db.twitch || {};
  res.json({
    configured: !!(settings.clientId && settings.accessToken),
    channel: settings.channel || '',
    clientId: settings.clientId ? '***configured***' : '',
    hasTokens: !!(settings.accessToken && settings.refreshToken)
  });
});

// Save Twitch settings
app.post('/api/twitch/settings', (req, res) => {
  const { clientId, clientSecret, accessToken, refreshToken, channel } = req.body;

  if (!db.twitch) db.twitch = {};

  if (clientId) db.twitch.clientId = clientId;
  if (clientSecret) db.twitch.clientSecret = clientSecret;
  if (accessToken) db.twitch.accessToken = accessToken;
  if (refreshToken) db.twitch.refreshToken = refreshToken;
  if (channel) db.twitch.channel = channel;

  saveDB(db);
  res.json({ success: true });
});

// Connect to Twitch
app.post('/api/twitch/connect', async (req, res) => {
  try {
    const settings = db.twitch || {};

    if (!settings.clientId || !settings.clientSecret || !settings.accessToken || !settings.refreshToken) {
      return res.status(400).json({ error: 'Twitch credentials not configured. Please set up your Twitch app credentials.' });
    }

    if (!settings.channel) {
      return res.status(400).json({ error: 'Channel name not configured' });
    }

    const result = await connectTwitch(
      settings.clientId,
      settings.clientSecret,
      settings.accessToken,
      settings.refreshToken,
      settings.channel
    );

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Disconnect from Twitch
app.post('/api/twitch/disconnect', async (req, res) => {
  await disconnectTwitch();
  res.json({ success: true });
});

// Send chat message
app.post('/api/twitch/say', async (req, res) => {
  const { message } = req.body;

  if (!twitchState.connected || !twitchState.chatClient) {
    return res.status(400).json({ error: 'Not connected to Twitch' });
  }

  try {
    await twitchState.chatClient.say(twitchState.channel, message);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get recent chat messages
app.get('/api/twitch/chat', (req, res) => {
  res.json(twitchState.recentMessages);
});

// Get recent events
app.get('/api/twitch/events', (req, res) => {
  res.json(twitchState.eventLog);
});

// Clear credentials
app.post('/api/twitch/clear', async (req, res) => {
  await disconnectTwitch();
  delete db.twitch;
  saveDB(db);
  res.json({ success: true });
});

// Load Twitch settings and auto-connect on startup
if (db.twitch && db.twitch.clientId && db.twitch.accessToken && db.twitch.channel) {
  console.log('Twitch credentials found, auto-connecting...');
  setTimeout(() => {
    connectTwitch(
      db.twitch.clientId,
      db.twitch.clientSecret,
      db.twitch.accessToken,
      db.twitch.refreshToken,
      db.twitch.channel
    ).catch(e => console.error('Twitch auto-connect failed:', e.message));
  }, 2000);
}

// Start HTTP server
const server = app.listen(CONFIG.httpPort, () => {
  console.log(`
=================================
  Stream Companion Server
=================================
  HTTP API:    http://localhost:${CONFIG.httpPort}
  WebSocket:   ws://localhost:${CONFIG.wsPort}
  Overlays:    http://localhost:${CONFIG.httpPort}/
=================================
`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${CONFIG.httpPort} already in use`);
  } else {
    console.error('Server error:', err.message);
  }
});

// Auto-save every 30 seconds
setInterval(() => saveDB(db), 30000);

module.exports = { server, wss, db };
