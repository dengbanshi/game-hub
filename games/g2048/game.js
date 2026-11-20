/* ==========================================================================
   g2048/game.js —— 2048
   --------------------------------------------------------------------------
   负责：棋盘规则、渲染、键盘与滑动、复盘。
   不负责：顶栏与帮助弹层（shared/game-shell.js）、复盘排版（shared/review-panel.js）。

   结构按 doc/DEV-GUIDE.md §4.1：常量 → 状态 → 纯函数 → 渲染 → 交互 → 复盘 → 启动。

   这个游戏对外讲的是「状态空间搜索」，所以复盘必须能回答一个问题：
   你输在空间管理上，还是输在按键乱？为此有两件事不能省：

     1. 棋盘规则写成纯函数。界面和复盘里的「机械策略」共用同一份规则，
        否则对照出来的数字来自另一套规则，等于没对照。
     2. 随机数走种子。同一开局才能换个策略重跑，这是反事实那一层的前提；
        顺带也满足规范里「不用 Math.random() 做判定」那一条。
   ========================================================================== */

// ---------------------------------------------------------------- 1. 常量

const N = 4;

const COLORS = {
  2:    ['#f2f6fd', '#465063'],
  4:    ['#dce8fa', '#33415a'],
  8:    ['#cadcfb', '#1b3a8f'],
  16:   ['#a6c4fa', '#14306f'],
  32:   ['#7ea6f7', '#0b1f4f'],
  64:   ['#4f7bf0', '#ffffff'],
  128:  ['#3b5bfd', '#ffffff'],
  256:  ['#2f49d6', '#ffffff'],
  512:  ['#2637b0', '#ffffff'],
  1024: ['#1d2a8a', '#ffffff'],
  2048: ['#121a5e', '#ffd76a'],
};

/** 机械策略的按键顺序：只按下、左、右，永不按上。 */
const POLICY_ORDER = ['down', 'left', 'right'];

/** 机械策略单局最多走多少步。纯粹是防御死循环，正常一局远到不了。 */
const POLICY_MAX_STEPS = 6000;

// ---------------------------------------------------------------- 2. 状态

const boardEl = document.getElementById('board');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const hintEl = document.getElementById('hint');

const store = GameShell.store('g2048');

let cells = [];
let grid = [];
let score = 0;
// 兼容旧版本直接写在 game-hub-2048-best 里的最高分，不让老玩家的记录凭空消失
let best = Number(store.get('best', Number(localStorage.getItem('game-hub-2048-best') || 0)) || 0);
let reached2048 = false;

/** 每局的种子：反事实要拿它重跑，所以必须留在状态里。 */
let seed = 0;
let rng = null;
let roundNo = 0;

/** 本局统计。复盘全从这里取数，不做二次猜测。 */
let stats = { moves: 0, wasted: 0, corner: 0, history: [] };

const overEl = document.createElement('div');
overEl.className = 'over';
overEl.hidden = true;
boardEl.append(overEl);

for (let i = 0; i < N * N; i++) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cells.push(cell);
  boardEl.append(cell);
}

// ------------------------------------------------------------ 3. 纯函数棋盘

/**
 * mulberry32：小巧的种子随机数。
 * 用它而不是 Math.random()，是因为复盘要把「同一个开局」交给另一种策略重跑；
 * 没有可复现的随机流，两组数字就没有可比性。
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

function emptyGrid() {
  return Array.from({ length: N }, () => Array(N).fill(0));
}

/** 在空格里放一个新方块：90% 是 2，10% 是 4。 */
function spawn(board, random) {
  const empty = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) if (board[y][x] === 0) empty.push([x, y]);
  }
  if (!empty.length) return false;
  const [x, y] = empty[Math.floor(random() * empty.length)];
  board[y][x] = random() < 0.9 ? 2 : 4;
  return true;
}

/** 把一行压紧并合并。返回新行和合并得分。 */
function slideLine(line) {
  const values = line.filter((v) => v !== 0);
  const out = [];
  let gained = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === values[i + 1]) {
      out.push(values[i] * 2);
      gained += values[i] * 2;
      i++;
    } else {
      out.push(values[i]);
    }
  }
  while (out.length < N) out.push(0);
  return { out, gained };
}

function readLine(board, dir, i) {
  if (dir === 'left') return board[i].slice();
  if (dir === 'right') return board[i].slice().reverse();
  if (dir === 'up') return Array.from({ length: N }, (_, j) => board[j][i]);
  return Array.from({ length: N }, (_, j) => board[N - 1 - j][i]);
}

function writeLine(board, dir, i, line) {
  if (dir === 'left') { board[i] = line; return; }
  if (dir === 'right') { board[i] = line.slice().reverse(); return; }
  if (dir === 'up') { for (let j = 0; j < N; j++) board[j][i] = line[j]; return; }
  for (let j = 0; j < N; j++) board[N - 1 - j][i] = line[j];
}

/** 把一次移动作用在棋盘上（就地修改）。changed 为 false 表示这一步什么都不会发生。 */
function applyMove(board, dir) {
  let changed = false;
  let gained = 0;
  for (let i = 0; i < N; i++) {
    const before = readLine(board, dir, i);
    const { out, gained: gain } = slideLine(before);
    gained += gain;
    if (out.join(',') !== before.join(',')) changed = true;
    writeLine(board, dir, i, out);
  }
  return { changed, gained };
}

/** 还有没有任何一步能改变棋盘。 */
function canMove(board) {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (board[y][x] === 0) return true;
      if (x + 1 < N && board[y][x] === board[y][x + 1]) return true;
      if (y + 1 < N && board[y][x] === board[y + 1][x]) return true;
    }
  }
  return false;
}

function maxTile(board) {
  return board.reduce((max, row) => Math.max(max, ...row), 0);
}

/** 最大块是否在四角之一。「把大数钉在角落」是 2048 里最强的启发式。 */
function maxInCorner(board) {
  const max = maxTile(board);
  return [[0, 0], [0, N - 1], [N - 1, 0], [N - 1, N - 1]]
    .some(([y, x]) => board[y][x] === max);
}

/**
 * 机械策略：只按下 → 左 → 右，永不按上。它不做任何评估，只是把大数往下压。
 * 复盘拿它当对照，因为它不依赖玩家的操作水平，而且完全可复现。
 */
function runCornerPolicy(seedValue) {
  const policyRng = makeRng(seedValue);
  const board = emptyGrid();
  spawn(board, policyRng);
  spawn(board, policyRng);
  let total = 0;

  for (let step = 0; step < POLICY_MAX_STEPS; step++) {
    let moved = false;
    for (const dir of POLICY_ORDER) {
      // 先在副本上试，确认这一步真的能改变棋盘再采用
      const probe = board.map((row) => row.slice());
      const { changed, gained } = applyMove(probe, dir);
      if (!changed) continue;
      for (let y = 0; y < N; y++) board[y] = probe[y];
      total += gained;
      spawn(board, policyRng);
      moved = true;
      break;
    }
    // 三个键都动不了：这局对这个策略来说就结束了（它不会去按上）
    if (!moved) break;
  }

  return { score: total, max: maxTile(board) };
}

// ---------------------------------------------------------------- 4. 渲染

function render() {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cell = cells[y * N + x];
      const value = grid[y][x];
      cell.textContent = value || '';
      const palette = COLORS[value] || COLORS[2048];
      cell.style.background = value ? palette[0] : '#d7dfea';
      cell.style.color = value ? palette[1] : 'transparent';
      cell.className = 'cell' + (value >= 1024 ? ' huge' : value >= 128 ? ' big' : '');
      if (value) {
        cell.classList.remove('pop');
        void cell.offsetWidth;
        cell.classList.add('pop');
      }
    }
  }
  scoreEl.textContent = score;
  bestEl.textContent = best;
}

function showOver() {
  overEl.hidden = false;
  overEl.replaceChildren();
  const text = document.createElement('div');
  text.textContent = '没有可走的格子了，最终 ' + score + ' 分。';
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'primary';
  again.textContent = '再来一局';
  again.addEventListener('click', start);
  overEl.append(text, again);
}

// ---------------------------------------------------------------- 5. 交互

function move(dir) {
  const { changed, gained } = applyMove(grid, dir);

  // 按了但棋子没动：这不是「无效操作」那么简单，它说明你在乱试方向。
  // 记下来是因为复盘要能指出「你的按键里有多少是纯浪费」。
  if (!changed) {
    stats.wasted += 1;
    return;
  }

  score += gained;
  if (score > best) {
    best = score;
    store.set('best', best);
  }

  spawn(grid, rng);
  stats.moves += 1;
  const corner = maxInCorner(grid);
  if (corner) stats.corner += 1;
  stats.history.push({ corner, max: maxTile(grid) });

  render();

  if (!reached2048 && grid.some((row) => row.some((v) => v >= 2048))) {
    reached2048 = true;
    hintEl.textContent = '达成 2048，还能继续冲更高。';
  }

  if (!canMove(grid)) {
    showOver();
    finishReview();
  }
}

function start() {
  roundNo += 1;
  // 用时间戳掺一个递增计数派生种子：同一毫秒内连点两次也不会重样
  seed = (Date.now() ^ Math.imul(roundNo, 2654435761)) >>> 0;
  rng = makeRng(seed);

  grid = emptyGrid();
  score = 0;
  reached2048 = false;
  stats = { moves: 0, wasted: 0, corner: 0, history: [] };

  overEl.hidden = true;
  hintEl.textContent = '';
  GameReview.hide();

  spawn(grid, rng);
  spawn(grid, rng);
  render();
}

// ---------------------------------------------------------------- 6. 复盘

/**
 * 五段结构见 doc/DEV-GUIDE.md §2.5。
 * 反事实用「同一开局的机械策略」而不是「理论上限」：前者可复现、可验证，
 * 后者只能靠我嘴说，玩家没有理由相信。
 */
function finishReview() {
  const max = maxTile(grid);
  const moves = stats.moves;
  const cornerRatio = moves ? stats.corner / moves : 0;
  const presses = moves + stats.wasted;
  const wastedRatio = presses ? stats.wasted / presses : 0;

  // 最大块最后一次待在角落之后，再没回去过——2048 里最典型的「输因」。
  let lastCornerIndex = -1;
  stats.history.forEach((step, index) => {
    if (step.corner) lastCornerIndex = index;
  });
  const leftCornerAt = lastCornerIndex >= 0 && !stats.history[stats.history.length - 1].corner
    ? lastCornerIndex + 1
    : 0;

  // ① 判定
  let verdict;
  if (max >= 2048) {
    verdict =
      '你合出了 2048。真正起作用的不是运气，而是最大块始终有「下一个合并对象」——' +
      '下面的角落驻留比例，就是这件事的度量。';
  } else if (max >= 1024) {
    verdict =
      '停在 1024。棋盘还没满就结束，通常意味着最大块被挤出了角落——' +
      '它一旦进了中间，四周全是能堵死它的空格。';
  } else if (max >= 512) {
    verdict =
      '卡在 512。这个阶段最容易犯的错是「见合并就合」，把大数一步步推到中间，' +
      '之后每一步都在救火。';
  } else {
    verdict =
      `最大块只合到 ${max}，棋盘就填满了。这基本不是手速问题——` +
      '说明你在用「见合并就合」的贪心走，从来没有为某一块预留过位置。';
  }

  // ③ 归因：三条，每条都能指到具体步数
  const items = [
    {
      tone: cornerRatio >= 0.7 ? 'good' : cornerRatio >= 0.35 ? 'warn' : 'bad',
      mark: cornerRatio >= 0.7 ? '✓' : '!',
      text: `最大块有 ${stats.corner} / ${moves} 步待在四角之一（${Math.round(cornerRatio * 100)}%）`,
    },
    {
      tone: wastedRatio <= 0.1 ? 'good' : wastedRatio <= 0.25 ? 'warn' : 'bad',
      mark: wastedRatio <= 0.1 ? '✓' : '!',
      text: `一共按了 ${presses} 次方向键，其中 ${stats.wasted} 次棋子根本没动（${Math.round(wastedRatio * 100)}%）`,
    },
  ];

  if (leftCornerAt) {
    items.push({
      tone: 'bad',
      mark: '✕',
      text: `第 ${leftCornerAt} 步之后，最大块离开角落再没回去，剩下的 ${moves - leftCornerAt} 步都在救火`,
    });
  } else if (lastCornerIndex >= 0) {
    items.push({
      tone: 'good',
      mark: '✓',
      text: '最大块整局都守在角落里——这正是 2048 里最强的那条启发式',
    });
  } else {
    items.push({
      tone: 'bad',
      mark: '✕',
      text: '整局最大块一次都没进过角落，等于主动放弃了唯一的空间约束',
    });
  }

  // ④ 反事实：同一开局的机械策略
  const same = runCornerPolicy(seed);
  const sample = [];
  for (let i = 1; i <= 9; i++) {
    sample.push(runCornerPolicy((seed + i * 7919) >>> 0).score);
  }
  sample.sort((a, b) => a - b);
  const median = sample[Math.floor(sample.length / 2)];

  const bars = [
    { label: '你这局', value: score, text: score + ' 分', mine: true },
    { label: '机械策略 · 同一开局', value: same.score, text: same.score + ' 分' },
    { label: '机械策略 · 10 局中位', value: median, text: median + ' 分' },
  ];
  const bestBar = bars.reduce((a, b) => (b.value > a.value ? b : a));

  // ⑤ 建议：挑最强的那一个信号，不列清单
  let advice;
  if (cornerRatio < 0.4) {
    advice =
      '先把最大块钉死在一个角落，并且永远不要为了合并把它推出来。' +
      '这条约束看起来只是习惯，实际上砍掉了棋盘上一大半的状态空间。';
  } else if (wastedRatio > 0.25) {
    advice =
      `你有 ${Math.round(wastedRatio * 100)}% 的按键完全没改变棋盘。` +
      '无效按键不扣分，但它占掉了你判断下一个有效移动的时间——先看清棋盘再按，比按得快重要。';
  } else if (same.score > score) {
    advice =
      `你的操作没问题，但同一开局下那个「只会按下、左、右」的机械策略拿到 ${same.score} 分。` +
      '它没有任何判断力，唯一的优势是从不破坏角落。这说明启发式的价值大于临场反应。';
  } else {
    advice =
      `这局你赢过了机械策略（${same.score} 分）。想再进一步，试试更早地把第二大的块也归到同一个角：` +
      '两条大数链并排，才撑得住 4096 之后的空间。';
  }

  GameReview.show({
    meta: `最大块 ${max} · 种子 ${seed}`,
    verdict,
    metrics: [
      { label: '最终分数', value: score, strong: true },
      { label: '最大块', value: max },
      { label: '有效移动', value: moves },
      { label: '无效按键', value: stats.wasted },
    ],
    attribution: { kind: 'list', label: '归因 · 这一局发生了什么', items },
    counterfactual: {
      label: '反事实 · 同一开局换个策略',
      note: '同一个种子意味着前两个方块的位置完全一样；再换成「只会按下→左→右、永不按上」' +
        '这个固定策略，用同一套合并与出块规则重跑一遍。它不做任何判断。',
      bars: bars.map((bar) => ({
        label: bar.label,
        value: bar.value,
        text: bar.text,
        best: bar === bestBar,
        mine: Boolean(bar.mine),
      })),
      footer: `那个机械策略在同一开局下合到了 ${same.max}，10 个不同开局的中位分是 ${median} 分。`,
    },
    advice,
  });
}

// ---------------------------------------------------------------- 7. 启动

const KEYS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  a: 'left', d: 'right', w: 'up', s: 'down',
};

document.addEventListener('keydown', (event) => {
  // 帮助弹层打开时不响应方向键，否则读者在弹层里按方向键翻页，棋盘会跟着滑。
  if (window.GameShell && GameShell.isHelpOpen()) return;

  const dir = KEYS[event.key];
  if (!dir) return;
  event.preventDefault();
  move(dir);
});

let touchStart = null;
boardEl.addEventListener('pointerdown', (event) => {
  touchStart = { x: event.clientX, y: event.clientY };
});
boardEl.addEventListener('pointerup', (event) => {
  if (!touchStart) return;
  const dx = event.clientX - touchStart.x;
  const dy = event.clientY - touchStart.y;
  touchStart = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
  else move(dy > 0 ? 'down' : 'up');
});

document.getElementById('newGame').addEventListener('click', start);

start();
