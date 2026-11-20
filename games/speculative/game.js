/* ==========================================================================
   speculative/game.js —— 投机采样（猜词接力）
   --------------------------------------------------------------------------
   这个文件负责：概率模型、一轮猜测与验收的计算、渲染、复盘。
   它不负责：顶栏与帮助弹层（shared/game-shell.js）。

   结构按 doc/DEV-GUIDE.md §4.1：常量 → 状态 → 纯函数 → 渲染 → 交互 → 启动。
   所有随机数都由「位置 + 通道」派生，不用 Math.random()，
   因为玩家必须能把某一步的失败归因到具体的比值上，而不是归因到运气。
   ========================================================================== */

// ---------------------------------------------------------------- 1. 常量

// 要生成的句子。39 个 token，长度刚好够玩家试出 k 的拐点，又不至于一局太久。
const SENTENCE = [
  '推理', '加速', '的', '关键', '不在于', '更快', '的', '单卡', '，',
  '而', '在于', '减少', '串行', '的', '空转', '。',
  '投机', '采样', '用', '一个', '小模型', '先', '猜', '出一串', '，',
  '大模型', '一次', '验收', '，', '猜对', '的', '直接', '采信', '，',
  '猜错', '的位置', '重新', '采样', '。',
];

// draft 猜错时可能落到哪些词上。这些词只用于构造「错误分布」，不参与正文。
const DECOYS = [
  '的', '模型', '吞吐', '延迟', '显存', '一次', '部分', '位置',
  '验证', '批处理', '缓存', '解码', '并行', '算子', '推理', '调度',
];

const PUNCT = new Set(['，', '。', '；', '、']);
const FUNCTION_WORDS = new Set(['的', '而', '用', '一次', '一个', '先', '直接', '重新', '在于']);

// 三档「draft 有多像 target」。weak 是 draft 把握的基础弱化比例，
// gamma 是每往后猜一位的衰减——draft 是在自己猜出来的历史上继续猜，误差会累积。
// 这两个数不是拍脑袋：weak 对应常见蒸馏小模型 70%~85% 的 top-1 一致率，
// gamma 对应「自回归误差随步数放大」的经验衰减。
const LEVELS = {
  close: {
    name: '接近',
    weak: 0.86,
    gamma: 0.97,
    note: 'draft 很像 target：长串也撑得住，k 可以放大。',
  },
  mid: {
    name: '中等',
    weak: 0.75,
    gamma: 0.90,
    note: '常见的蒸馏小模型水平，长串开始明显衰减。',
  },
  far: {
    name: '偏差大',
    weak: 0.55,
    gamma: 0.65,
    note: '两个不同源的模型，越猜越偏，长 k 基本是浪费。',
  },
};

const KS = [1, 2, 4, 8, 16];

// 验证一轮的耗时模型：1（一次前向的基础延迟）+ 线性项（并行验证 k+1 个位置）
// + 平方项（长序列下 attention 与 kernel 效率下降）。
// 真实 GPU 上 k=4 通常能拿到 2~3 倍，这里刻意保守，让「k 过大」的代价可见。
const TIME = { base: 1, linear: 0.05, quad: 0.004 };

// 固定种子：同一难度下，同一个位置的 draft 采样与验收随机数每次都一样，
// 这样「换个 k 再跑一遍」才是可比较的对照实验，而不是重开一局碰运气。
const SEED = 20261120;

const K_NOTES = {
  1: '退化成一次猜一个，只多了一次验证开销。',
  2: '低风险的保守取值。',
  4: '线上最常见的取值区间。',
  8: '长串命中率是乘起来的，越往后越像买彩票。',
  16: '除非 draft 几乎等于 target，否则这一串基本白猜。',
};

// ---------------------------------------------------------------- 2. 状态

const state = {
  levelId: 'mid',
  k: 4,
  pos: 0,
  time: 0,
  rounds: [],
  busy: false,
  done: false,
  playToken: 0,     // 递增令牌，用来作废「重开之后仍在跑的旧动画」
  lastAdvance: 0,
};

const store = GameShell.store('speculative');

const el = {
  sentence: document.getElementById('sentence'),
  progress: document.getElementById('progress'),
  ks: document.getElementById('ks'),
  levels: document.getElementById('levels'),
  knote: document.getElementById('knote'),
  levelnote: document.getElementById('levelnote'),
  run: document.getElementById('run'),
  reset: document.getElementById('reset'),
  status: document.getElementById('status'),
  track: document.getElementById('track'),
  tracknote: document.getElementById('tracknote'),
  stRounds: document.getElementById('st-rounds'),
  stTokens: document.getElementById('st-tokens'),
  stTime: document.getElementById('st-time'),
  stSpeed: document.getElementById('st-speed'),
  review: document.getElementById('review'),
  reviewLevel: document.getElementById('review-level'),
  verdict: document.getElementById('verdict'),
  rvSpeed: document.getElementById('rv-speed'),
  rvTime: document.getElementById('rv-time'),
  rvAccept: document.getElementById('rv-accept'),
  rvMean: document.getElementById('rv-mean'),
  roundsBody: document.getElementById('rounds-body'),
  reviewHint: document.getElementById('review-hint'),
  kcurve: document.getElementById('kcurve'),
};

// ---------------------------------------------------------------- 3. 概率模型

/** target 对这个位置有多确定。标点最确定，虚词次之，实词最不确定。 */
function confidence(token) {
  if (PUNCT.has(token)) return 0.94;
  if (FUNCTION_WORDS.has(token)) return 0.86;
  return 0.72;
}

/** 为某个位置挑两个干扰词，必须稳定可复现，且不等于正确答案。 */
function decoysFor(pos, gold) {
  const pool = DECOYS.filter((word) => word !== gold);
  const a = pool[(pos * 5 + 1) % pool.length];
  const b = pool[(pos * 5 + 7) % pool.length];
  const c = pool[(pos * 5 + 11) % pool.length];
  return [a, b === a ? c : b];
}

/** target（大模型）在某位置的分布：正确答案高概率，两个干扰词平分剩余。 */
function targetDist(pos) {
  const gold = SENTENCE[pos];
  const pt = confidence(gold);
  const [d1, d2] = decoysFor(pos, gold);
  const rest = (1 - pt) / 2;
  const dist = {};
  dist[gold] = pt;
  dist[d1] = rest;
  dist[d2] = rest;
  return { order: [gold, d1, d2], dist };
}

/**
 * draft（小模型）在某位置的分布。
 * j 是「这一轮里的第几个猜测」：j 越大，draft 越是踩在自己猜出来的历史上，
 * 把握越低。这是投机采样里最容易忽略、但对最优 k 影响最大的一件事。
 */
function draftDist(pos, j, level) {
  const gold = SENTENCE[pos];
  const pt = confidence(gold);
  const [d1, d2] = decoysFor(pos, gold);
  const dg = pt * level.weak * Math.pow(level.gamma, j);
  const rest = (1 - dg) / 2;
  const dist = {};
  dist[gold] = dg;
  dist[d1] = rest;
  dist[d2] = rest;
  return { order: [gold, d1, d2], dist };
}

// ---------------------------------------------------------------- 4. 随机数

/**
 * 由「位置 + 通道 + 固定种子」派生 0~1 的随机数。
 * 通道用来区分用途：1 = draft 采样，2 = 验收，3 = 残差重采样。
 * 不用 Math.random()：那样每次重开结果都不同，玩家无法判断「是我选错了 k 还是运气差」。
 */
function rand01(pos, channel) {
  let x = (pos * 374761393 + channel * 668265263 + SEED) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

function sample(order, dist, r) {
  let acc = 0;
  for (const token of order) {
    acc += dist[token];
    if (r < acc) return token;
  }
  return order[order.length - 1];
}

/**
 * 被拒之后的修正采样：从残差分布 max(0, p_target - p_draft) 里重新采一个词。
 * 这一步是投机采样「输出分布与 target 单独解码完全一致」的全部原因。
 * 如果偷懒直接取 target 的 argmax，加速还在，但分布就偏了。
 */
function residualSample(pos, j, level) {
  const target = targetDist(pos);
  const draft = draftDist(pos, j, level);
  const weights = target.order.map((token) =>
    Math.max(0, (target.dist[token] || 0) - (draft.dist[token] || 0))
  );
  const total = weights.reduce((sum, w) => sum + w, 0);
  const r = rand01(pos, 3);

  if (total <= 0) return sample(target.order, target.dist, r);

  let acc = 0;
  const point = r * total;
  for (let i = 0; i < target.order.length; i++) {
    acc += weights[i];
    if (point < acc) return target.order[i];
  }
  return target.order[0];
}

// ---------------------------------------------------------------- 5. 一轮的规划

/**
 * 计算一轮会发生什么。这是整个游戏唯一的算法入口：
 * 游戏内的动画和复盘的曲线都调用它，避免两边各写一份判定而慢慢跑偏。
 *
 * 返回的 guesses 包含全部 slots 个猜测（draft 确实是先猜完再验证的），
 * 但只有 rejectIdx 之前的部分会被接受——被拒之后的那几个猜测，成本已经付了，收益是零。
 */
function planRound(pos, k, levelId) {
  const level = LEVELS[levelId];
  const slots = Math.min(k, SENTENCE.length - pos);

  const guesses = [];
  for (let j = 0; j < slots; j++) {
    const draft = draftDist(pos + j, j, level);
    const token = sample(draft.order, draft.dist, rand01(pos + j, 1));
    const target = targetDist(pos + j);
    const pd = draft.dist[token];
    const pt = target.dist[token] || 0;
    // 接受概率 = min(1, p_target / p_draft)。draft 比 target 更保守时直接接受。
    const ratio = Math.min(1, pt / pd);
    const u = rand01(pos + j, 2);
    guesses.push({ pos: pos + j, j, token, pd, pt, ratio, u, ok: u < ratio });
  }

  let accepted = 0;
  let rejectIdx = -1;
  for (let j = 0; j < guesses.length; j++) {
    if (guesses[j].ok) accepted++;
    else { rejectIdx = j; break; }
  }

  const fix = rejectIdx >= 0 ? residualSample(pos + rejectIdx, rejectIdx, level) : null;

  // 被拒：接受的部分 + target 修正的 1 个 token。
  // 全接受：再多送 1 个 bonus token（target 的那次前向顺便给出了下一个位置的概率）。
  let advance = accepted;
  if (rejectIdx >= 0) advance += 1;
  else if (pos + advance < SENTENCE.length) advance += 1;

  const time = TIME.base + TIME.linear * slots + TIME.quad * slots * slots;

  return { pos, k, slots, guesses, accepted, rejectIdx, fix, advance, time };
}

/** 用同样的规则把整句跑完，只返回汇总。复盘里的 k 曲线靠它。 */
function simulate(k, levelId) {
  let pos = 0;
  let time = 0;
  let rounds = 0;
  let acceptedTotal = 0;

  while (pos < SENTENCE.length) {
    const round = planRound(pos, k, levelId);
    pos += round.advance;
    time += round.time;
    rounds += 1;
    acceptedTotal += round.accepted;
  }

  return {
    k,
    speed: SENTENCE.length / time,
    time,
    rounds,
    // 平均每轮接受长度：判断「你猜的 k 有没有被用满」的关键指标。
    meanAccepted: acceptedTotal / rounds,
  };
}

// ---------------------------------------------------------------- 6. 渲染

function renderSentence() {
  const frag = document.createDocumentFragment();
  SENTENCE.forEach((token, i) => {
    const span = document.createElement('span');
    const done = i < state.pos;
    span.className = 'tok ' + (done ? 'done' : 'pending');
    if (done && i >= state.pos - state.lastAdvance) span.classList.add('fresh');
    // 没生成的位置只画占位点。这里如果用浅灰色直接把 token 写出来，
    // 玩家开局就能读到整句答案，整个游戏就没有悬念了。
    span.textContent = done ? token : '·';
    frag.append(span);
  });
  el.sentence.replaceChildren(frag);
  el.progress.textContent = `${state.pos} / ${SENTENCE.length}`;
}

function renderChips() {
  el.ks.replaceChildren(
    ...KS.map((k) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip' + (k === state.k ? ' is-active' : '');
      btn.textContent = String(k);
      btn.setAttribute('aria-pressed', String(k === state.k));
      btn.addEventListener('click', () => {
        if (state.busy || state.done) return;
        state.k = k;
        renderChips();
        updateNotes();
      });
      return btn;
    })
  );

  el.levels.replaceChildren(
    ...Object.entries(LEVELS).map(([id, level]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip' + (id === state.levelId ? ' is-active' : '');
      btn.textContent = level.name;
      btn.setAttribute('aria-pressed', String(id === state.levelId));
      btn.addEventListener('click', () => {
        if (state.busy) return;
        // 换难度等于换了一道题，直接重开，避免半局数据混在一起。
        state.levelId = id;
        resetGame();
      });
      return btn;
    })
  );
}

function updateNotes() {
  el.knote.textContent = K_NOTES[state.k] || '';
  el.levelnote.textContent = LEVELS[state.levelId].note;
}

function renderStats() {
  el.stRounds.textContent = String(state.rounds.length);
  el.stTokens.textContent = String(state.pos);
  el.stTime.textContent = state.time.toFixed(1);
  el.stSpeed.textContent = state.time > 0 ? (state.pos / state.time).toFixed(2) + '×' : '—';
}

function stepRow(guess, status) {
  const row = document.createElement('div');
  row.className = 'g-row ' + (
    status === 'accept' ? 'is-accept' : status === 'reject' ? 'is-reject' : 'is-skip'
  );

  const idx = document.createElement('span');
  idx.className = 'g-idx';
  idx.textContent = '#' + (guess.j + 1);

  const token = document.createElement('span');
  token.className = 'g-token';
  token.textContent = guess.token;

  const probs = document.createElement('span');
  probs.className = 'g-probs';

  const result = document.createElement('span');
  result.className = 'g-result';

  if (status === 'skip') {
    // 被拒之后的猜测根本没有被验证。这里列出概率会误导玩家，
    // 以为它「算过但没通过」，实际上它连被比较的机会都没有。
    probs.append(probItem('状态', '已截断，未验证'));
    result.textContent = '—';
  } else {
    probs.append(
      probItem('p_draft', guess.pd.toFixed(2)),
      probItem('p_target', guess.pt.toFixed(2)),
      probItem('接受概率', guess.ratio.toFixed(2) + ' ≥ u ' + guess.u.toFixed(2))
    );
    result.textContent = status === 'accept' ? '✓ 接受' : '✗ 拒绝';
  }

  row.append(idx, token, probs, result);
  return row;
}

function probItem(label, value) {
  const wrap = document.createElement('span');
  const name = document.createElement('i');
  name.style.fontStyle = 'normal';
  name.textContent = label + ' ';
  const val = document.createElement('b');
  val.textContent = value;
  wrap.append(name, val);
  return wrap;
}

function fixRow(fix) {
  const row = document.createElement('div');
  row.className = 'fix-row';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = '修正';
  const text = document.createElement('span');
  text.append('target 从残差 ');
  const code = document.createElement('code');
  code.textContent = 'max(0, p_target − p_draft)';
  text.append(code, ' 里重采样得到 ');
  const word = document.createElement('b');
  word.textContent = fix;
  text.append(word, '，这一格仍然正确，只是多花了一次前向。');
  row.append(tag, text);
  return row;
}

/** 逐步揭示本轮验收：一次全画出来，玩家只会看到一个总分，看不到因果。 */
function revealRound(round, token) {
  el.track.replaceChildren();
  el.tracknote.textContent = `k=${round.k} · 实际验证 ${round.slots} 个位置`;

  const rows = [];
  for (let j = 0; j < round.guesses.length; j++) {
    if (round.rejectIdx >= 0 && j > round.rejectIdx) {
      rows.push(stepRow(round.guesses[j], 'skip'));
      continue;
    }
    rows.push(stepRow(round.guesses[j], j === round.rejectIdx ? 'reject' : 'accept'));
  }
  if (round.fix) rows.push(fixRow(round.fix));

  const gap = Math.max(45, Math.min(110, 800 / Math.max(1, rows.length)));

  return new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      // token 变了说明玩家已经重开，立刻停下，不要往新棋盘里插旧行。
      if (token !== state.playToken) return resolve();
      if (i >= rows.length) return resolve();
      el.track.append(rows[i]);
      i += 1;
      if (i < rows.length) setTimeout(tick, gap);
      else setTimeout(resolve, 120);
    };
    tick();
  });
}

function renderReview() {
  const level = LEVELS[state.levelId];
  const total = state.time;
  const speed = SENTENCE.length / total;
  const acceptedSum = state.rounds.reduce((s, r) => s + r.accepted, 0);
  const guessSum = state.rounds.reduce((s, r) => s + r.slots, 0);

  el.reviewLevel.textContent = `难度：${level.name} · 39 个 token`;
  el.rvSpeed.textContent = speed.toFixed(2) + '×';
  el.rvTime.textContent = total.toFixed(1);
  el.rvAccept.textContent = guessSum ? Math.round((acceptedSum / guessSum) * 100) + '%' : '—';
  el.rvMean.textContent = (acceptedSum / Math.max(1, state.rounds.length)).toFixed(2);

  if (speed < 1) {
    el.verdict.textContent =
      '加速比小于 1：你比老老实实逐 token 生成还慢。验证一次的开销已经超过省下的时间，' +
      '说明这个 k 在当前的接受率下纯属浪费。';
  } else if (speed < 1.5) {
    el.verdict.textContent =
      '有一点加速，但不多。你的 k 偏大——接受率撑不住这么长的串，每轮真正用上的只有前两位。';
  } else if (speed < 2.2) {
    el.verdict.textContent =
      '这是投机采样在真实系统里的典型区间。你已经踩到了「猜得够长」和「猜得太长」之间的那条线。';
  } else {
    el.verdict.textContent =
      '接近这个时间模型下的上限了。draft 被你用得很充分，每轮几乎没有浪费的猜测。';
  }

  // 同一份规则、同一个种子，把每个 k 都跑一遍，作为「如果换 k 会怎样」的对照。
  const curve = KS.map((k) => simulate(k, state.levelId));
  const best = curve.reduce((a, b) => (b.speed > a.speed ? b : a));
  const max = Math.max(...curve.map((c) => c.speed));

  el.kcurve.replaceChildren(
    ...curve.map((item) => {
      const row = document.createElement('div');
      row.className = 'kcurve-row' + (item.k === best.k ? ' is-best' : '');

      const label = document.createElement('span');
      label.className = 'kcurve-k';
      label.textContent = 'k=' + item.k;

      const track = document.createElement('span');
      track.className = 'kcurve-track';
      const bar = document.createElement('i');
      bar.style.width = Math.max(2, (item.speed / max) * 100) + '%';
      track.append(bar);

      const val = document.createElement('span');
      val.className = 'kcurve-v';
      val.textContent = item.speed.toFixed(2) + '×';

      row.append(label, track, val);
      return row;
    })
  );

  el.roundsBody.replaceChildren(
    ...state.rounds.map((round, i) => {
      const tr = document.createElement('tr');
      if (round.k === best.k) tr.className = 'best';
      const cells = [
        String(i + 1),
        String(round.k),
        String(round.accepted),
        String(round.advance),
        round.time.toFixed(2),
        (round.cumulativeSpeed).toFixed(2) + '×',
      ];
      cells.forEach((text, index) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      });
      return tr;
    })
  );

  const bestRecord = store.get('best:' + state.levelId, 0);
  let hint =
    `在这档难度下，k=${best.k} 的平均表现最好（${best.speed.toFixed(2)}×）。` +
    `注意看 k 从 ${best.k} 继续往上时曲线为什么掉头：接受率是按位相乘的，` +
    `第 8 位还能命中的概率只有第 1 位的几分之一，而验证成本照付。`;

  if (bestRecord > 0 && speed > bestRecord) {
    store.set('best:' + state.levelId, Number(speed.toFixed(2)));
    hint += ` 这局刷新了本档最好成绩，原纪录 ${bestRecord.toFixed(2)}×。`;
  } else if (bestRecord > 0) {
    hint += ` 本档最好成绩 ${bestRecord.toFixed(2)}×。`;
  } else {
    // 第一次跑这一档，别说「原纪录 0.00×」——那读起来像系统坏了
    store.set('best:' + state.levelId, Number(speed.toFixed(2)));
    hint += ` 这是本档的第一条记录（${speed.toFixed(2)}×），后面再跑会拿来对照。`;
  }
  el.reviewHint.textContent = hint;

  el.review.hidden = false;
}

// ---------------------------------------------------------------- 7. 交互

function resetGame() {
  state.playToken += 1;      // 作废正在跑的动画
  state.pos = 0;
  state.time = 0;
  state.rounds = [];
  state.busy = false;
  state.done = false;
  state.lastAdvance = 0;

  el.review.hidden = true;
  el.tracknote.textContent = '';
  el.track.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = '选好 k，点「验证一轮」。每一步的概率都会摊开给你看。';
  el.track.append(empty);
  el.status.textContent = '';
  el.run.disabled = false;
  el.run.textContent = '验证一轮';

  renderChips();
  updateNotes();
  renderSentence();
  renderStats();
}

async function runRound() {
  if (state.busy || state.done) return;

  const token = ++state.playToken;

  state.busy = true;
  el.run.disabled = true;
  el.status.textContent = 'draft 正在猜…';

  const round = planRound(state.pos, state.k, state.levelId);

  // 先更新数据，再播放动画：动画只是把已经算好的结果解释给你看。
  state.pos += round.advance;
  state.time += round.time;
  state.lastAdvance = round.advance;
  state.rounds.push({
    ...round,
    cumulativeSpeed: state.pos / state.time,
  });

  await revealRound(round, token);

  // 动画期间玩家可能点了重开，此时状态已经清空，不能再往上写本轮的结论。
  if (token !== state.playToken) return;

  renderSentence();
  renderStats();

  const acceptedText = round.rejectIdx >= 0
    ? `接受 ${round.accepted} 个，第 ${round.rejectIdx + 1} 个被拒`
    : `全部 ${round.accepted} 个接受`;
  el.status.textContent = `${acceptedText} · 本轮推进 ${round.advance}，耗时 ${round.time.toFixed(2)}`;

  state.busy = false;

  if (state.pos >= SENTENCE.length) {
    state.done = true;
    el.run.disabled = true;
    el.run.textContent = '已完成';
    renderReview();
    el.review.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  el.run.disabled = false;
}

// ---------------------------------------------------------------- 8. 启动

el.run.addEventListener('click', runRound);
el.reset.addEventListener('click', resetGame);

resetGame();
