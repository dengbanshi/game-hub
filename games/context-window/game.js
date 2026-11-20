/* ==========================================================================
   context-window/game.js —— 上下文窗口（记忆背包）
   --------------------------------------------------------------------------
   负责：预算核算、信息的保留/压缩/丢弃、提问与判分、复盘。
   不负责：场景数据（scenario.js）、外壳（shared/game-shell.js）。

   这个游戏的全部张力来自一条规则：压缩占格更少但会丢细节。
   所以「哪些信息可以压」不是一个 UI 问题，是玩家要做的核心决策。
   ========================================================================== */

// ---------------------------------------------------------------- 1. 常量

const SRC_CLASS = {
  告警: 'src-alert',
  值班: 'src-mail',
  群聊: 'src-chat',
  变更: 'src-change',
  指标: 'src-metric',
  监控: 'src-metric',
  日志: 'src-log',
  邮件: 'src-mail',
};

const SRC_COLOR = {
  告警: '#be123c',
  值班: '#6b7280',
  群聊: '#c07a22',
  变更: '#7c3aed',
  指标: '#0369a1',
  监控: '#0369a1',
  日志: '#3b5bfd',
  邮件: '#6b7280',
};

const MODE_LABEL = { full: '原文', packed: '压缩', drop: '丢弃' };

const SCORE_PER_QUESTION = 20;
const SCORE_LUCKY = 10;

// ---------------------------------------------------------------- 2. 索引

// 场景数据只读一次，建两个索引：id → 条目、id → 排序权重。
// 排序权重用来保证窗口列表和格子条永远按「信息到达顺序」排列，
// 而不是按玩家的操作顺序跳来跳去。
const ITEMS = new Map();
const ORDER = new Map();

SCENARIO.rounds.forEach((round) => {
  round.items.forEach((item, index) => {
    ITEMS.set(item.id, item);
    ORDER.set(item.id, round.id * 100 + index);
  });
});

const KEY_ITEMS = [...ITEMS.values()].filter((item) => item.value === 'key');

// ---------------------------------------------------------------- 3. 状态

const state = {
  cursor: 0,
  queue: [],
  stage: null,
  window: [],
  decisions: {},
  answers: {},
  score: 0,
  peak: 0,
  answered: false,
  done: false,
  cards: new Map(),   // itemId → { root, buttons }
};

const el = {
  brief: document.getElementById('brief'),
  cells: document.getElementById('cells'),
  budgetText: document.getElementById('budgetText'),
  windowList: document.getElementById('windowList'),
  windowNote: document.getElementById('windowNote'),
  stageLabel: document.getElementById('stageLabel'),
  stageMeta: document.getElementById('stageMeta'),
  stage: document.getElementById('stage'),
  next: document.getElementById('next'),
  reset: document.getElementById('reset'),
  status: document.getElementById('status'),
  review: document.getElementById('review'),
  reviewMeta: document.getElementById('review-meta'),
  verdict: document.getElementById('verdict'),
  mScore: document.getElementById('m-score'),
  mUsage: document.getElementById('m-usage'),
  mNoise: document.getElementById('m-noise'),
  mLost: document.getElementById('m-lost'),
  detailList: document.getElementById('detailList'),
  reviewHint: document.getElementById('review-hint'),
};

// ---------------------------------------------------------------- 4. 纯函数

/** 压缩后的占用：大概三分之一，至少 1 格。 */
function packedSize(item) {
  return Math.max(1, Math.ceil(item.size / 3));
}

function usedSlots() {
  return state.window.reduce((sum, entry) => sum + entry.slots, 0);
}

function slotsFor(item, mode) {
  if (mode === 'full') return item.size;
  if (mode === 'packed') return packedSize(item);
  return 0;
}

/** 事件队列：轮次与提问按发生顺序排好，避免在渲染里散落一堆 if。 */
function buildQueue() {
  const queue = [];
  SCENARIO.rounds.forEach((round) => {
    queue.push({ type: 'round', round });
    SCENARIO.questions
      .filter((question) => question.afterRound === round.id)
      .forEach((question) => queue.push({ type: 'question', question }));
  });
  return queue;
}

/**
 * 判定一道题。
 * 关键不是「答对没有」，而是「你的窗口撑不撑得住这个答案」——
 * 答对但没有证据，在真实排障里叫运气，不叫能力。
 */
function evaluate(question, choice) {
  const correct = choice === question.answer;
  const missing = question.needs.filter((need) => {
    const entry = state.window.find((e) => e.item.id === need.item);
    if (!entry) return true;
    return need.level === 'full' && entry.mode !== 'full';
  });

  if (!correct) return { credit: 0, correct: false, missing };
  if (missing.length) return { credit: SCORE_LUCKY, correct: true, missing };
  return { credit: SCORE_PER_QUESTION, correct: true, missing: [] };
}

function missingText(missing) {
  return missing
    .map((need) => {
      const item = ITEMS.get(need.item);
      if (!item) return need.item;
      return `「${item.title}」${need.level === 'full' ? '的原文' : ''}`;
    })
    .join('、');
}

// ---------------------------------------------------------------- 5. 渲染

function renderCells() {
  const budget = SCENARIO.budget;
  const colors = [];
  state.window.forEach((entry) => {
    const color = SRC_COLOR[entry.item.from] || '#6b7280';
    for (let i = 0; i < entry.slots; i++) colors.push(color);
  });

  const cells = [];
  for (let i = 0; i < budget; i++) {
    const cell = document.createElement('i');
    cell.className = 'cell';
    if (colors[i]) cell.style.background = colors[i];
    cells.push(cell);
  }
  el.cells.replaceChildren(...cells);
  el.budgetText.textContent = `${usedSlots()} / ${budget} 格`;
}

function renderWindowList() {
  if (!state.window.length) {
    const empty = document.createElement('p');
    empty.className = 'win-empty';
    empty.textContent = '窗口是空的。你什么也没记住。';
    el.windowList.replaceChildren(empty);
    el.windowNote.textContent = '';
    return;
  }

  const rows = state.window.map((entry) => {
    const row = document.createElement('div');
    row.className = 'win-row';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = SRC_COLOR[entry.item.from] || '#6b7280';

    const title = document.createElement('span');
    title.className = 'win-title';
    title.textContent = entry.item.title;
    if (entry.mode === 'packed') {
      const mark = document.createElement('span');
      mark.className = 'packed-mark';
      mark.textContent = '（摘要）';
      title.append(mark);
    }

    const tag = document.createElement('span');
    tag.className = 'win-tag';
    tag.textContent = `${MODE_LABEL[entry.mode]} · ${entry.slots} 格`;

    row.append(dot, title, tag);

    // 窗口内条目还能继续压缩（真实系统里就是这样：空间不够时回头整理）
    if (entry.mode === 'full' && entry.item.size > 1) {
      const packBtn = document.createElement('button');
      packBtn.type = 'button';
      packBtn.className = 'mini';
      packBtn.textContent = '压缩';
      packBtn.addEventListener('click', () => decide(entry.item, 'packed'));
      row.append(packBtn);
    }

    const dropBtn = document.createElement('button');
    dropBtn.type = 'button';
    dropBtn.className = 'mini';
    dropBtn.textContent = '移除';
    dropBtn.addEventListener('click', () => decide(entry.item, 'drop'));
    row.append(dropBtn);

    return row;
  });

  el.windowList.replaceChildren(...rows);

  const noiseSlots = state.window
    .filter((e) => e.item.value === 'noise')
    .reduce((sum, e) => sum + e.slots, 0);
  el.windowNote.textContent = noiseSlots
    ? `其中 ${noiseSlots} 格是与任务无关的内容`
    : '';
}

function buildCard(item) {
  const card = document.createElement('article');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';

  const src = document.createElement('span');
  src.className = 'src ' + (SRC_CLASS[item.from] || 'src-mail');
  src.textContent = item.from;

  const time = document.createElement('span');
  time.className = 'time';
  // 时间从所属轮次取，数据里不重复存
  const round = SCENARIO.rounds.find((r) => r.items.includes(item));
  time.textContent = round ? round.time : '';

  head.append(src, time);

  const title = document.createElement('h3');
  title.textContent = item.title;

  const detail = document.createElement('p');
  detail.className = 'detail';
  detail.textContent = item.detail;

  const foot = document.createElement('div');
  foot.className = 'card-foot';

  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = `原文占 ${item.size} 格`;

  const choices = document.createElement('div');
  choices.className = 'choices';

  const modes = [
    { mode: 'full', label: `保留原文（${item.size} 格）` },
    { mode: 'packed', label: `压缩（${packedSize(item)} 格，丢细节）`, disabled: item.size <= 1 },
    { mode: 'drop', label: '丢弃' },
  ];

  const buttons = modes.map(({ mode, label, disabled }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.mode = mode;
    btn.textContent = label;
    if (disabled) {
      btn.disabled = true;
      btn.title = '只占 1 格，压缩没有意义';
    }
    btn.addEventListener('click', () => decide(item, mode));
    choices.append(btn);
    return btn;
  });

  foot.append(size, choices);
  card.append(head, title, detail, foot);

  state.cards.set(item.id, { root: card, buttons, item });
  return card;
}

function syncCards() {
  state.cards.forEach(({ root, buttons, item }) => {
    const mode = state.decisions[item.id];
    root.className = 'card' + (mode ? ' is-' + mode : '');
    buttons.forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.mode === mode);
    });
  });
}

function renderRound(round) {
  state.cards.clear();
  el.stageLabel.textContent = `第 ${round.id} 轮 · ${round.label}`;
  el.stageMeta.textContent = round.time;
  el.stage.replaceChildren(...round.items.map(buildCard));
  syncCards();
}

function renderQuestion(question) {
  state.cards.clear();
  el.stageLabel.textContent = '提问';  el.stageMeta.textContent = `第 ${Object.keys(state.answers).length + 1} 题 / 共 ${SCENARIO.questions.length} 题`;

  const wrap = document.createElement('div');
  wrap.className = 'question';

  const text = document.createElement('p');
  text.className = 'q-text';
  text.textContent = question.text;

  const options = document.createElement('div');
  options.className = 'options';
  const buttons = question.options.map((label, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option';
    btn.textContent = label;
    btn.addEventListener('click', () => answer(question, index, buttons, wrap));
    options.append(btn);
    return btn;
  });

  wrap.append(text, options);
  el.stage.replaceChildren(wrap);
}

function buildResult(question, result) {
  const box = document.createElement('div');
  box.className = 'result ' + (result.credit === SCORE_PER_QUESTION ? 'good' : result.credit > 0 ? 'lucky' : 'bad');

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = result.credit === SCORE_PER_QUESTION ? '有据可依' : result.credit > 0 ? '蒙对了' : '答错';

  const body = document.createElement('span');
  if (result.credit === SCORE_PER_QUESTION) {
    body.textContent = question.explainRight;
  } else if (result.credit > 0) {
    body.textContent =
      question.explainRight +
      ` 但你的窗口里没有${missingText(result.missing)}，这个答案是靠印象补的——真实排障里，这通常叫运气。`;
  } else {
    body.textContent = question.explainWrong;
  }

  box.append(tag, body);
  return box;
}

function answer(question, choice, buttons, wrap) {
  if (state.answered) return;

  state.answered = true;
  const result = evaluate(question, choice);
  state.score += result.credit;
  state.answers[question.id] = { choice, ...result };

  buttons.forEach((btn, index) => {
    btn.disabled = true;
    if (index === question.answer) btn.classList.add('is-right');
    else if (index === choice) btn.classList.add('is-wrong');
  });

  wrap.append(buildResult(question, result));

  el.status.textContent = `+${result.credit} 分`;
  updateNext();
}

function updateNext() {
  const stage = state.stage;
  if (!stage) return;

  if (stage.type === 'question') {
    el.next.disabled = !state.answered;
    el.next.textContent = '继续';
    return;
  }

  const allDecided = stage.round.items.every((item) => state.decisions[item.id]);
  el.next.disabled = !allDecided;
  el.next.textContent = '进入下一轮';

  if (!allDecided) {
    const left = stage.round.items.filter((item) => !state.decisions[item.id]).length;
    el.status.textContent = `还有 ${left} 条信息没处理`;
  } else {
    el.status.textContent = '';
  }
}

// ---------------------------------------------------------------- 6. 操作

function decide(item, mode) {
  const existing = state.window.find((entry) => entry.item.id === item.id);
  const nextSlots = slotsFor(item, mode);
  const baseUsed = usedSlots() - (existing ? existing.slots : 0);

  if (mode !== 'drop' && baseUsed + nextSlots > SCENARIO.budget) {
    const need = baseUsed + nextSlots - SCENARIO.budget;
    el.status.textContent = `预算不够，还差 ${need} 格。先压缩或移除窗口里的条目。`;
    return;
  }

  state.window = state.window.filter((entry) => entry.item.id !== item.id);
  if (mode !== 'drop') {
    state.window.push({ item, mode, slots: nextSlots });
  }
  state.window.sort((a, b) => ORDER.get(a.item.id) - ORDER.get(b.item.id));

  state.decisions[item.id] = mode;
  state.peak = Math.max(state.peak, usedSlots());

  renderCells();
  renderWindowList();
  syncCards();
  updateNext();
}

function loadStage() {
  if (state.cursor >= state.queue.length) {
    finish();
    return;
  }

  state.stage = state.queue[state.cursor];
  state.answered = false;
  el.status.textContent = '';

  if (state.stage.type === 'round') renderRound(state.stage.round);
  else renderQuestion(state.stage.question);

  updateNext();
}

function next() {
  if (el.next.disabled) return;
  state.cursor += 1;
  loadStage();
}

// ---------------------------------------------------------------- 7. 复盘

function finish() {
  state.done = true;
  state.stage = null;

  el.stageLabel.textContent = '结束';
  el.stageMeta.textContent = '';
  // 不清空成一个空白面板：那看起来像页面没加载完
  const endNote = document.createElement('p');
  endNote.className = 'win-empty';
  endNote.textContent = `${SCENARIO.rounds.length} 轮信息流已结束，下面是你的判断结果。`;
  el.stage.replaceChildren(endNote);
  el.status.textContent = '';

  const budget = SCENARIO.budget;
  const used = usedSlots();
  const noiseSlots = state.window
    .filter((entry) => entry.item.value === 'noise')
    .reduce((sum, entry) => sum + entry.slots, 0);
  const lost = KEY_ITEMS.filter((item) => state.decisions[item.id] === 'drop').length;
  const packedKeys = KEY_ITEMS.filter((item) => state.decisions[item.id] === 'packed').length;

  const ratio = used ? noiseSlots / used : 0;
  const peakRatio = state.peak / budget;

  el.reviewMeta.textContent = `${SCENARIO.questions.length} 题 · 满分 ${SCENARIO.questions.length * SCORE_PER_QUESTION}`;
  el.mScore.textContent = String(state.score);
  el.mUsage.textContent = Math.round(peakRatio * 100) + '%';
  el.mNoise.textContent = Math.round(ratio * 100) + '%';
  el.mLost.textContent = String(lost);

  if (state.score >= SCENARIO.questions.length * SCORE_PER_QUESTION) {
    el.verdict.textContent =
      '满分。你留下的每一格都撑住了一个结论，而且没有把预算浪费在闲聊上——' +
      '这就是一个合格的上下文策略：够用，且不臃肿。';
  } else if (state.score >= SCENARIO.questions.length * SCORE_PER_QUESTION * 0.66) {
    el.verdict.textContent =
      '大部分结论站得住，但有一两处是靠印象补的。真实事故里，这种「差不多记得」' +
      '往往比明确不知道更危险，因为它会让你跳过验证。';
  } else {
    el.verdict.textContent =
      '分数偏低。不是你推理能力的问题，是证据没留住——窗口里的东西撑不住你的结论。';
  }

  const rows = SCENARIO.questions.map((question, index) => {
    const record = state.answers[question.id];
    const row = document.createElement('div');
    row.className = 'detail-row';

    if (!record) {
      row.classList.add('is-warn');
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = '·';
      const text = document.createElement('span');
      text.textContent = `第 ${index + 1} 题未作答`;
      row.append(mark, text);
      return row;
    }

    const full = record.credit === SCORE_PER_QUESTION;
    row.classList.add(full ? 'is-good' : record.credit > 0 ? 'is-warn' : 'is-bad');

    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = full ? '✓' : record.credit > 0 ? '!' : '✕';

    const text = document.createElement('span');
    if (full) {
      text.textContent = `第 ${index + 1} 题：答对，证据完整（+${record.credit}）`;
    } else if (record.credit > 0) {
      text.textContent = `第 ${index + 1} 题：答对但缺${missingText(record.missing)}，按蒙对计（+${record.credit}）`;
    } else {
      text.textContent = `第 ${index + 1} 题：答错（+0）`;
    }

    row.append(mark, text);
    return row;
  });

  el.detailList.replaceChildren(...rows);

  // 只给最要紧的一条建议，列五条等于没建议
  const fullScore = SCENARIO.questions.length * SCORE_PER_QUESTION;
  let hint;
  if (state.score >= fullScore) {
    hint = `这局满分，而且是每一题都有据可依。想加点难度：把 scenario.js 里的 budget 从 ${budget} 降到 20，` +
      '同样的题目还能不能全对？那时候你必须在「压缩哪一条」上做真正的取舍。';
  } else if (ratio > 0.3) {
    hint = `你把 ${Math.round(ratio * 100)}% 的窗口留给了与任务无关的内容。` +
      '如果把这几格换成关键日志的原文，第 3 题就不会丢分。';
  } else if (packedKeys > 0) {
    hint = `你压缩了 ${packedKeys} 条关键证据。压缩省下的格子确实有用，` +
      '但摘要答不了「具体数字是多少」这类问题——这就是压缩的延迟代价。';
  } else if (lost > 0) {
    hint = `你丢掉了 ${lost} 条关键证据。有些题即使答对了，也只能算蒙对：` +
      '结论对了，但你的窗口撑不住它。';
  } else {
    hint = '这次的关键证据你都留住了，但仍有失分。回头看看是不是题目的因果链没串起来——' +
      '证据齐全不等于结论正确。';
  }
  el.reviewHint.textContent = hint;

  el.review.hidden = false;
  el.next.disabled = true;
  el.next.textContent = '已结束';
  el.reset.textContent = '再玩一次';
  el.review.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------- 8. 启动

function resetGame() {
  state.cursor = 0;
  state.queue = buildQueue();
  state.stage = null;
  state.window = [];
  state.decisions = {};
  state.answers = {};
  state.score = 0;
  state.peak = 0;
  state.answered = false;
  state.done = false;
  state.cards.clear();

  el.review.hidden = true;
  el.next.disabled = true;
  el.next.textContent = '进入下一轮';
  el.reset.textContent = '重开';
  el.status.textContent = '';
  el.brief.textContent = SCENARIO.brief;

  renderCells();
  renderWindowList();
  loadStage();
}

el.next.addEventListener('click', next);
el.reset.addEventListener('click', resetGame);

resetGame();
