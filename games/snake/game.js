/* ==========================================================================
   snake/game.js —— 贪吃蛇
   --------------------------------------------------------------------------
   负责：游戏循环、渲染、键盘与滑动、复盘。
   不负责：顶栏与帮助弹层（shared/game-shell.js）、复盘排版（shared/review-panel.js）。

   这个游戏对外讲的是「Agent 循环」：读状态 → 选动作 → 承担后果 → 状态改变。
   所以复盘要能回答「你死在哪一拍」，而不是只报一个分数。为此记了三样东西：
     1. 存活帧数与转向次数——转向太频，说明你在用按键代替判断；
     2. 死因（撞墙 / 撞自己）；
     3. 致命那一步的方向是不是来自队列——「我以为往左，实际往右」是 Agent 的经典故障。

   随机数走种子：反事实要拿同一个开局让机械策略重跑，没有可复现的随机流就没有对照。
   ========================================================================== */

// ---------------------------------------------------------------- 1. 常量

const COLS = 20;
const ROWS = 20;
const CELL = 24;
const FOOD_SCORE = 10;

/** 机械策略单局最多走多少帧，纯防御。 */
const POLICY_MAX_STEPS = 6000;

/** 四个方向。机械策略与玩家共用，避免两边对「方向」的理解出现偏差。 */
const DIRECTIONS = [
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
];

// ---------------------------------------------------------------- 2. 状态

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const dpr = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = COLS * CELL * dpr;
canvas.height = ROWS * CELL * dpr;
ctx.scale(dpr, dpr);

const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const store = GameShell.store('snake');

let snake;
let dir;
let pending;
let food;
let score;
let timer = null;
let state = 'ready';

// 兼容旧版本直接写在 game-hub-snake-best 里的最高分
let best = Number(store.get('best', Number(localStorage.getItem('game-hub-snake-best') || 0)) || 0);

let seed = 0;
let rng = null;
let roundNo = 0;

/** 本局统计，复盘只从这里取数。 */
let stats = { frames: 0, turns: 0, cause: null, fromQueue: false };

// ------------------------------------------------------------ 3. 纯函数

/**
 * mulberry32：种子随机数。同一开局才能让机械策略跑出可比较的对照。
 */
function makeRng(seedValue) {
  let a = seedValue >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在空格里随机挑一格放食物；与玩家局共用同一条规则。 */
function pickFood(body, random) {
  const free = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!body.some((segment) => segment.x === x && segment.y === y)) free.push({ x, y });
    }
  }
  return free.length ? free[Math.floor(random() * free.length)] : null;
}

/** 机械策略：只做一步安全检查，然后朝食物靠近。它不做任何预判。 */
function chooseGreedy(body, heading, target) {
  const head = body[0];
  const options = DIRECTIONS.filter((d) => !(d.x === -heading.x && d.y === -heading.y));

  let pick = null;
  let bestDistance = Infinity;

  for (const d of options) {
    const next = { x: head.x + d.x, y: head.y + d.y };

    // 撞墙：直接淘汰
    if (next.x < 0 || next.y < 0 || next.x >= COLS || next.y >= ROWS) continue;

    // 撞自己：不吃食物的时候尾巴会移开，所以最后一节不算障碍
    const eats = target && next.x === target.x && next.y === target.y;
    const limit = eats ? body.length : body.length - 1;
    let blocked = false;
    for (let i = 0; i < limit; i++) {
      if (body[i].x === next.x && body[i].y === next.y) { blocked = true; break; }
    }
    if (blocked) continue;

    // 安全的方向里，挑离食物最近的那个（曼哈顿距离）
    const distance = target
      ? Math.abs(next.x - target.x) + Math.abs(next.y - target.y)
      : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      pick = d;
    }
  }

  return pick;
}

/**
 * 用同一个种子把「朝食物直线冲」的策略跑一整局。
 * 它只做一次安全检查（下一步会不会撞），没有任何前瞻——
 * 所以它比人弱的地方恰恰是「人以为自己有前瞻」，而人比它弱的地方是「没有那次安全检查」。
 */
function runGreedyPolicy(seedValue) {
  const policyRng = makeRng(seedValue);
  let body = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  let heading = { x: 1, y: 0 };
  let target = pickFood(body, policyRng);
  let total = 0;

  for (let step = 0; step < POLICY_MAX_STEPS; step++) {
    const choice = chooseGreedy(body, heading, target);
    if (!choice) break;          // 三个方向都会死，这局结束

    heading = choice;
    const head = { x: body[0].x + heading.x, y: body[0].y + heading.y };
    const eats = target && head.x === target.x && head.y === target.y;

    body.unshift(head);
    if (eats) {
      total += FOOD_SCORE;
      target = pickFood(body, policyRng);
    } else {
      body.pop();
    }
  }

  return { score: total, length: body.length };
}

/** 速度：初始 150ms 一帧，每 50 分加快 8ms，最快 70ms。 */
function speed() {
  return Math.max(70, 150 - Math.floor(score / 50) * 8);
}

// ---------------------------------------------------------------- 4. 渲染

function draw() {
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);

  ctx.fillStyle = 'rgba(255,255,255,.045)';
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) ctx.fillRect(x * CELL + CELL - 2, y * CELL + CELL - 2, 2, 2);
  }

  if (food) {
    ctx.fillStyle = '#ff8a4c';
    ctx.beginPath();
    ctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }

  snake.forEach((segment, i) => {
    ctx.fillStyle = i === 0 ? '#dbe6ff' : '#7fa2ff';
    const pad = i === 0 ? 1 : 2;
    ctx.fillRect(segment.x * CELL + pad, segment.y * CELL + pad, CELL - pad * 2, CELL - pad * 2);
  });

  if (state !== 'running') {
    const label = state === 'over'
      ? '撞了 · ' + score + ' 分'
      : state === 'paused' ? '已暂停' : '按开始或方向键出发';
    ctx.fillStyle = 'rgba(15,17,23,.72)';
    ctx.fillRect(0, ROWS * CELL / 2 - 30, COLS * CELL, 60);
    ctx.fillStyle = '#e8eefc';
    ctx.font = '500 17px system-ui,-apple-system,"PingFang SC",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, (COLS * CELL) / 2, (ROWS * CELL) / 2);
  }
}

// ---------------------------------------------------------------- 5. 循环

function placeFood() {
  food = pickFood(snake, rng);
}

function reset() {
  clearTimeout(timer);
  roundNo += 1;
  seed = (Date.now() ^ Math.imul(roundNo, 2654435761)) >>> 0;
  rng = makeRng(seed);

  snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  dir = { x: 1, y: 0 };
  pending = [];
  score = 0;
  state = 'ready';
  stats = { frames: 0, turns: 0, cause: null, fromQueue: false };

  placeFood();
  scoreEl.textContent = '0';
  bestEl.textContent = best;
  document.getElementById('start').textContent = '开始';
  GameReview.hide();
  draw();
}

function startGame() {
  if (state === 'running') return;
  state = 'running';
  document.getElementById('start').textContent = '进行中';
  clearTimeout(timer);
  timer = setTimeout(tick, speed());
  draw();
}

function pauseGame() {
  if (state === 'running') {
    state = 'paused';
    clearTimeout(timer);
    draw();
  } else if (state === 'paused') {
    state = 'running';
    timer = setTimeout(tick, speed());
    draw();
  }
}

function gameOver() {
  state = 'over';
  clearTimeout(timer);
  if (score > best) {
    best = score;
    store.set('best', best);
    bestEl.textContent = best;
  }
  document.getElementById('start').textContent = '再来一局';
  draw();
  finishReview();
}

function tick() {
  if (state !== 'running') return;

  // 从队列里取一个合法方向。这里要记住「这一帧的方向是不是玩家新给的」——
  // 死亡时如果用的是队列里的方向，说明他以为的当前方向和实际执行的不一样。
  let fromQueue = false;
  while (pending.length) {
    const next = pending.shift();
    if (next.x === -dir.x && next.y === -dir.y) continue;
    if (next.x === dir.x && next.y === dir.y) continue;
    dir = next;
    fromQueue = true;
    stats.turns += 1;
    break;
  }

  stats.frames += 1;

  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
  const hitWall = head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS;
  const hitSelf = snake.some((s, i) => i < snake.length - 1 && s.x === head.x && s.y === head.y);

  if (hitWall || hitSelf) {
    stats.cause = hitWall ? 'wall' : 'self';
    stats.fromQueue = fromQueue;
    gameOver();
    return;
  }

  snake.unshift(head);
  if (food && head.x === food.x && head.y === food.y) {
    score += FOOD_SCORE;
    scoreEl.textContent = score;
    placeFood();
  } else {
    snake.pop();
  }

  draw();
  timer = setTimeout(tick, speed());
}

// ---------------------------------------------------------------- 6. 复盘

/**
 * 五段结构见 doc/DEV-GUIDE.md §2.5。
 * 这里的反事实不是「理论上你能活多久」，而是同一开局下一条只做一步安全检查的机械蛇——
 * 可以让玩家自己去判断：我输在反应，还是输在判断。
 */
function finishReview() {
  const frames = stats.frames;
  const turns = stats.turns;
  const turnRate = frames ? turns / frames : 0;

  // ① 判定
  let verdict;
  if (score >= 300) {
    verdict =
      `吃到 ${score} 分。这个长度下蛇身已经接近棋盘的四分之一，` +
      '还能活下来说明你在转向时确实做了安全检查，而不是凭手感赌。';
  } else if (score >= 100) {
    verdict =
      `吃到 ${score} 分。这个阶段最常见的死法不是没看见食物，而是为了追食物把自己逼进角落——` +
      '看看下面「致命那一步」。';
  } else if (score >= 30) {
    verdict =
      `只吃到 ${score} 分。蛇还短的时候死亡，基本都是那一次转向没有检查后果：` +
      '动作已经排进队列，等你看到问题时已经执行了。';
  } else {
    verdict =
      `只吃到 ${score} 分。这么早结束，通常不是手速问题——` +
      '先按住一个方向跑，比每帧都换方向活得更久。';
  }

  // ③ 归因
  const causeText = stats.cause === 'self' ? '撞到自己身体' : '撞到墙';
  const items = [
    {
      tone: score >= 100 ? 'good' : 'warn',
      mark: score >= 100 ? '✓' : '!',
      text: `存活 ${frames} 帧，吃到 ${score} 分，蛇长 ${snake.length}`,
    },
    {
      tone: turnRate > 0.5 ? 'warn' : 'good',
      mark: turnRate > 0.5 ? '!' : '✓',
      text: `一共转向 ${turns} 次，平均每 ${turnRate > 0 ? (1 / turnRate).toFixed(1) : '—'} 帧改一次方向` +
        (turnRate > 0.5 ? '——转向太频，等于用按键代替判断' : ''),
    },
  ];

  if (stats.fromQueue) {
    items.push({
      tone: 'bad',
      mark: '✕',
      text: `致命那一步（${causeText}）用的是你上一帧排进队列的方向：` +
        '你以为当前方向是 A，实际执行的是 B。这正是 Agent 里「意图与已执行意图没分开」的经典故障。',
    });
  } else {
    items.push({
      tone: 'bad',
      mark: '✕',
      text: `致命那一步（${causeText}）方向没变，是你沿着原方向一直走到了终点——` +
        '没有及时改，而不是改错。',
    });
  }

  // ④ 反事实
  const same = runGreedyPolicy(seed);
  const sample = [];
  for (let i = 1; i <= 9; i++) {
    sample.push(runGreedyPolicy((seed + i * 7919) >>> 0).score);
  }
  sample.sort((a, b) => a - b);
  const median = sample[Math.floor(sample.length / 2)];

  const bars = [
    { label: '你这局', value: score, text: score + ' 分', mine: true },
    { label: '机械策略 · 同一开局', value: same.score, text: same.score + ' 分' },
    { label: '机械策略 · 10 局中位', value: median, text: median + ' 分' },
  ];
  const bestBar = bars.reduce((a, b) => (b.value > a.value ? b : a));

  // ⑤ 建议
  let advice;
  if (stats.fromQueue) {
    advice =
      '下次想转向时，先看一眼「这一刻蛇头在哪」，再决定按哪个键。' +
      '队列里的动作会延后一帧生效，这一帧足够让你的判断和现实错位。';
  } else if (turnRate > 0.5) {
    advice =
      '把转向频率降下来：每两帧最多改一次方向。多数时候你需要的不是更快的反应，' +
      '而是让蛇沿着一条长直线多走几格，给下一步留出空间。';
  } else if (same.score > score) {
    advice =
      `同一开局下，那条只做一步安全检查的机械蛇拿到 ${same.score} 分。` +
      '它没有前瞻，只是每次转向都确认「下一步不会撞」——你缺的就是这一次确认。';
  } else {
    advice =
      `这局你赢过了机械蛇（${same.score} 分）。想再往上，注意别在贴边时追食物：` +
      '把蛇头保持在离墙两格以上的地方，转弯余地会大很多。';
  }

  GameReview.show({
    meta: `蛇长 ${snake.length} · 种子 ${seed}`,
    verdict,
    metrics: [
      { label: '得分', value: score, strong: true },
      { label: '蛇长', value: snake.length },
      { label: '存活帧数', value: frames },
      { label: '转向次数', value: turns },
    ],
    attribution: { kind: 'list', label: '归因 · 这一局发生了什么', items },
    counterfactual: {
      label: '反事实 · 同一开局换个策略',
      note: '同一个种子意味着第一条食物的位置完全一样；再让一条「只朝食物直线走、只在下一步会撞时才改向」' +
        '的机械蛇跑一遍。它没有前瞻，也不会紧张。',
      bars: bars.map((bar) => ({
        label: bar.label,
        value: bar.value,
        text: bar.text,
        best: bar === bestBar,
        mine: Boolean(bar.mine),
      })),
      footer: '这条机械蛇不受帧率限制，也不需要反应时间，所以它更强是正常的。' +
        '这里比的不是手速，而是「你有没有在每次转向时做那一次安全检查」。',
    },
    advice,
  });
}

// ---------------------------------------------------------------- 7. 启动

const DIRS = {
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
  a: { x: -1, y: 0 }, d: { x: 1, y: 0 }, w: { x: 0, y: -1 }, s: { x: 0, y: 1 },
};

/** 玩家按下一个方向：排队，最多存两个，避免连按把意图堆成乱码。 */
function steer(d) {
  if (state === 'ready' || state === 'over') {
    if (state === 'over') reset();
    pending.push(d);
    startGame();
    return;
  }
  if (pending.length < 2) pending.push(d);
}

document.addEventListener('keydown', (event) => {
  // 帮助弹层打开时不要抢键盘：否则在弹层里按空格想翻页，游戏却被暂停了。
  if (window.GameShell && GameShell.isHelpOpen()) return;

  if (event.key === ' ') {
    event.preventDefault();
    if (state === 'running' || state === 'paused') pauseGame();
    else startGame();
    return;
  }
  if (event.key === 'r' || event.key === 'R') {
    reset();
    startGame();
    return;
  }
  const d = DIRS[event.key];
  if (!d) return;
  event.preventDefault();
  steer(d);
});

let touchStart = null;
canvas.addEventListener('pointerdown', (event) => {
  touchStart = { x: event.clientX, y: event.clientY };
});
canvas.addEventListener('pointerup', (event) => {
  if (!touchStart) return;
  const dx = event.clientX - touchStart.x;
  const dy = event.clientY - touchStart.y;
  touchStart = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
  steer(Math.abs(dx) > Math.abs(dy)
    ? { x: dx > 0 ? 1 : -1, y: 0 }
    : { x: 0, y: dy > 0 ? 1 : -1 });
});

document.getElementById('start').addEventListener('click', () => {
  if (state === 'over') reset();
  startGame();
});
document.getElementById('pause').addEventListener('click', pauseGame);
document.getElementById('restart').addEventListener('click', () => { reset(); startGame(); });

reset();
