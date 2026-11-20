/* ==========================================================================
   walk-shell.js —— 所有「图解 / 演练」页共用的外壳
   --------------------------------------------------------------------------
   图解和游戏是两种产物：
     游戏   —— 有输赢，靠决策和复盘建立直觉。
     图解   —— 没有输赢，靠「看清每一步 + 拧一下参数看变化」建立结构认知。

   所以它不需要复盘面板（没有「你这局 vs 换个做法」），但需要三样游戏里没有的
   东西，而且这三样各写一遍必定写歪：
     1. 顶部常驻的全流程图，任何时刻都能看到自己在整条链路的哪个位置
     2. 上一步 / 下一步（含键盘 ← →），且步骤可自由来回，不是单向播片
     3. 参数面板：拧一下，当前步骤立刻重画

   页面零 markup：写一个空的 <main>，脚本加载后把整套结构填进去。
   「忘记写导航」「忘记接参数」在结构上就不该发生。

   依赖：shared/game-shell.js（顶栏 / 帮助弹层 / 存档命名空间）。
   不要引入 shared/review-panel.js —— 图解没有输赢，复盘在这里是空转。
   ========================================================================== */

(function () {
  'use strict';

  const STORE_STEP = 'step';
  const STORE_PARAMS = 'params';
  const MIN_STEPS = 2;

  let ctx = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function findRoot() {
    return (
      document.getElementById('walk-root') ||
      document.querySelector('main') ||
      document.body
    );
  }

  function storeOf(id) {
    if (!window.GameShell || typeof window.GameShell.store !== 'function') {
      console.warn(
        '[walk-shell] 没有找到 window.GameShell。图解页必须先引入 shared/game-shell.js，' +
        '否则顶栏、帮助弹层、步骤记忆都不会生效。'
      );
      return null;
    }
    return window.GameShell.store(id);
  }

  function defaultValue(spec) {
    if (spec.type === 'toggle') return spec.value !== false;
    return spec.value;
  }

  function formatValue(spec, value) {
    if (spec.format) return spec.format(value);
    if (spec.type === 'toggle') return value ? '开' : '关';
    return String(value);
  }

  // ------------------------------------------------------------------ 流程图

  /**
   * 顶部流程图。按 step.group 自动分组，组与组之间换行——
   * 12 个步骤挤一行会小到看不清，而「输入 / 主干 / 输出 / 解码」这种阶段划分
   * 本身就是读者需要的信息，不该只写在文档里。
   */
  function renderFlow() {
    const host = ctx.flowEl;
    host.replaceChildren();

    let currentGroup = null;
    let chips = null;
    let inGroup = 0;

    ctx.steps.forEach((step, index) => {
      const groupName = step.group || '';

      if (groupName !== currentGroup) {
        currentGroup = groupName;
        inGroup = 0;
        const block = el('div', 'wk-group');
        if (groupName) block.append(el('span', 'wk-group-name', groupName));
        chips = el('div', 'wk-chips');
        block.append(chips);
        host.append(block);
      }

      if (inGroup > 0) chips.append(el('span', 'wk-arrow', '›'));

      const chip = el('button', 'wk-chip');
      chip.type = 'button';
      chip.append(
        el('i', 'wk-chip-no', String(index + 1).padStart(2, '0')),
        el('span', 'wk-chip-text', step.short || step.title)
      );

      // 已走过 / 当前：用「实心小方块 + 加粗」双重标记，不只靠颜色
      if (index < ctx.index) chip.classList.add('is-done');
      if (index === ctx.index) chip.classList.add('is-active');
      chip.setAttribute('aria-current', index === ctx.index ? 'step' : 'false');
      chip.addEventListener('click', () => goTo(index));

      chips.append(chip);
      inGroup += 1;
    });
  }

  // ------------------------------------------------------------------ 参数区

  /**
   * 参数控件的写值路径要分开处理：
   * range 在拖动过程中每一帧都会触发 input，如果这时重建整个参数面板，
   * 正在被拖的 DOM 节点会被换掉，拖动会立刻中断。
   * 所以 range 只更新读数 + 重画画布，select / toggle 才整块重建。
   */
  function setValue(id, value, options) {
    const opts = options || {};
    ctx.values[id] = value;

    if (ctx.store) {
      try { ctx.store.set(STORE_PARAMS, ctx.values); } catch (error) { /* 存不上不影响当前页面 */ }
    }

    if (opts.rebuildParams !== false) renderParams();
    redraw();
  }

  function buildControl(spec) {
    const value = ctx.values[spec.id];

    if (spec.type === 'select') {
      const select = el('select', 'wk-select');
      (spec.options || []).forEach((option) => {
        const node = el('option', null, option.label);
        node.value = option.value;
        if (option.value === value) node.selected = true;
        select.append(node);
      });
      select.addEventListener('change', () => setValue(spec.id, select.value));
      return { control: select, readout: null };
    }

    if (spec.type === 'toggle') {
      const button = el('button', 'wk-switch' + (value ? ' is-on' : ''));
      button.type = 'button';
      button.setAttribute('role', 'switch');
      button.setAttribute('aria-checked', String(Boolean(value)));
      button.setAttribute('aria-label', spec.label);
      button.append(el('i'));
      button.addEventListener('click', () => setValue(spec.id, !ctx.values[spec.id]));
      return { control: button, readout: null };
    }

    const range = el('input', 'wk-range');
    range.type = 'range';
    range.min = spec.min;
    range.max = spec.max;
    range.step = spec.step;
    range.value = value;
    const readout = el('output', 'wk-readout', formatValue(spec, value));
    range.addEventListener('input', () => {
      readout.textContent = formatValue(spec, range.value);
      setValue(spec.id, Number(range.value), { rebuildParams: false });
    });
    return { control: range, readout };
  }

  function renderParams() {
    const host = ctx.paramsEl;
    host.replaceChildren();

    const ids = ctx.steps[ctx.index].params || [];
    const specs = ids
      .map((id) => ctx.specs[id])
      .filter(Boolean);

    if (!specs.length) {
      host.append(el('p', 'wk-params-empty', '这一步没有可调参数，按「下一步」继续。'));
      return;
    }

    host.append(el('span', 'wk-params-title', '调一调'));
    specs.forEach((spec) => {
      const row = el('label', 'wk-param');
      row.append(el('span', 'wk-param-label', spec.label));
      const built = buildControl(spec);
      row.append(built.control);
      if (built.readout) row.append(built.readout);
      if (spec.hint) row.append(el('span', 'wk-param-hint', spec.hint));
      host.append(row);
    });
  }

  // ------------------------------------------------------------------ 画布原语

  /**
   * 画布原语：指标卡、条形图、流程图块、判断条。
   *
   * 为什么这些放进共享层，而注意力矩阵、token 链不放：
   * 前者是「两个图解都必须长得一样」的东西——同一个条形图在两个页面里
   * 一个圆角一个直角、一个 8px 一个 10px，读者会以为它们含义不同。
   * 后者是每个图解真正独有的画法，各写各的才对。
   *
   * 判断标准沿用 ARCHITECTURE §4.4：各写一遍会不会有人写歪并且没人发现？
   */
  const ui = {
    stats(host, items) {
      const grid = el('div', 'wk-stats');
      host.append(grid);
      (items || []).forEach((item) => ui.statCard(grid, item));
      return grid;
    },

    /**
     * 往已有网格里追加一张卡。
     * 单张卡片自己包一层 .wk-stats 是最常见的写错法：四张卡会变成四个独立的网格，
     * 在宽屏上竖着排成四行，看起来像四种不同的东西。所以这里把「往网格里加」单独开放出来。
     */
    statCard(grid, item) {
      const card = el('div', 'wk-stat' + (item.tone ? ' is-' + item.tone : ''));
      card.append(
        el('span', 'wk-stat-label', item.label),
        el('b', 'wk-stat-value', item.value)
      );
      grid.append(card);
      return card;
    },

    stat(host, item) {
      return ui.stats(host, [item]);
    },

    /**
     * 条形对照。value 只决定长度，text 决定显示什么——
     * 各图解的数值量纲不同（概率、token 数、倍数），组件不替它们做格式化。
     */
    bars(host, items) {
      const list = items || [];
      const max = Math.max.apply(null, list.map((it) => Math.abs(Number(it.value) || 0)).concat([1e-9]));
      const wrap = el('div', 'wk-bars');

      list.forEach((item) => {
        const row = el(
          'div',
          'wk-bar' + (item.dim ? ' is-dim' : '') + (item.hit ? ' is-hit' : '')
        );
        const track = el('span', 'wk-bar-track');
        const fill = el('i');
        const ratio = Math.abs(Number(item.value) || 0) / max;
        fill.style.width = Math.max(1.5, ratio * 100) + '%';
        track.append(fill);
        row.append(
          el('span', 'wk-bar-label', item.label),
          track,
          el('span', 'wk-bar-value', item.text)
        );
        wrap.append(row);
      });

      host.append(wrap);
      return wrap;
    },

    note(host, text) {
      host.append(el('p', 'wk-note', text));
      return host;
    },

    label(host, text) {
      host.append(el('p', 'wk-sublabel', text));
      return host;
    },

    /** 横向流程块。tone='accent' 用来标出「这一步是重点」。 */
    flow(host, boxes, arrow) {
      const row = el('div', 'wk-flowrow');
      (boxes || []).forEach((box, i) => {
        if (i > 0) row.append(el('span', 'wk-flowarrow', arrow || '→'));
        const node = el('div', 'wk-flowbox' + (box.tone ? ' is-' + box.tone : ''));
        node.append(el('b', null, box.title));
        if (box.sub) node.append(el('span', null, box.sub));
        row.append(node);
      });
      host.append(row);
      return row;
    },

    /** 判断条：tone = 'ok' | 'bad' | undefined（中性）。颜色之外还有左侧色条，不只靠色相。 */
    verdict(host, text, tone) {
      const node = el('p', 'wk-verdict' + (tone ? ' is-' + tone : ''), text);
      host.append(node);
      return node;
    },
  };

  // ------------------------------------------------------------------ 画布

  function redraw() {
    const stage = ctx.stageEl;
    const step = ctx.steps[ctx.index];
    stage.replaceChildren();

    if (typeof step.draw !== 'function') {
      console.error('[walk-shell] 第 ' + (ctx.index + 1) + ' 步缺少 draw()，这一屏会是空的。');
      stage.append(el('p', 'wk-error', '这一步还没有实现绘制函数 draw(stage, ctx)。'));
      return;
    }

    try {
      step.draw(stage, ctx.api);
    } catch (error) {
      // 图解页最容易死在「某一步引用了不存在的参数」上，直接抛错会连导航一起白屏，
      // 让读者连换一步都做不到。这里把错误关在这一屏里。
      console.error('[walk-shell] 第 ' + (ctx.index + 1) + ' 步绘制失败：', error);
      stage.append(el('p', 'wk-error', '这一步的绘制出错了：' + error.message));
    }
  }

  // ------------------------------------------------------------------ 导航

  function renderHead() {
    const step = ctx.steps[ctx.index];
    ctx.noEl.textContent = String(ctx.index + 1).padStart(2, '0');
    ctx.stepTitleEl.textContent = step.title;
    ctx.captionEl.textContent = step.caption || '';
    ctx.countEl.textContent = (ctx.index + 1) + ' / ' + ctx.steps.length;

    const atStart = ctx.index === 0;
    const atEnd = ctx.index === ctx.steps.length - 1;

    ctx.prevBtn.disabled = !ctx.loop && atStart;
    ctx.nextBtn.disabled = !ctx.loop && atEnd;

    // 循环式图解（如 Agent 循环）首尾相接，按钮永远可点，所以只在结尾提示一次去处；
    // 线性图解（如 Transformer 链路）走到头就是走到头，按钮直接禁用。
    if (ctx.loop) {
      ctx.prevBtn.textContent = '← 上一步';
      ctx.nextBtn.textContent = atEnd ? '回到第一步 →' : '下一步 →';
    } else {
      ctx.prevBtn.textContent = atStart ? '← 已经是第一步' : '← 上一步';
      ctx.nextBtn.textContent = atEnd ? '已经是最后一步' : '下一步 →';
    }
  }

  function goTo(index) {
    let next = index;
    if (ctx.loop) {
      next = (index + ctx.steps.length) % ctx.steps.length;
    } else {
      next = Math.max(0, Math.min(ctx.steps.length - 1, index));
    }
    if (next === ctx.index) return;

    ctx.index = next;
    if (ctx.store) {
      try { ctx.store.set(STORE_STEP, next); } catch (error) { /* 同上 */ }
    }

    renderFlow();
    renderHead();
    renderParams();
    redraw();
    ctx.stageEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function onKeydown(event) {
    if (!ctx) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    // 帮助弹层打开时方向键属于弹层，不能同时翻步骤
    if (window.GameShell && window.GameShell.isHelpOpen && window.GameShell.isHelpOpen()) return;

    const tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goTo(ctx.index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      goTo(ctx.index + 1);
    }
  }

  // ------------------------------------------------------------------ 挂载

  function mount(config) {
    const steps = Array.isArray(config.steps) ? config.steps : [];

    if (steps.length < MIN_STEPS) {
      console.error(
        '[walk-shell] 图解至少要有 ' + MIN_STEPS + ' 步。' +
        '只有一步的「图解」其实是一张插图，不需要导航和参数，直接写成静态页面更省事。'
      );
      return null;
    }

    // 参数在图解级别声明一次，步骤按 id 引用。同一个温度可能在第 8 步和第 10 步都要看，
    // 如果允许每一步各声明一遍，两份默认值迟早会不一致。
    const specs = {};
    (config.params || []).forEach((spec) => {
      specs[spec.id] = spec;
    });

    const store = storeOf(config.id);
    const values = Object.assign({}, config.values || {});
    (config.params || []).forEach((spec) => {
      values[spec.id] = defaultValue(spec);
    });
    if (store) {
      const saved = store.get(STORE_PARAMS, null);
      if (saved && typeof saved === 'object') {
        Object.keys(saved).forEach((key) => {
          if (key in specs) values[key] = saved[key];
        });
      }
    }

    let start = 0;
    if (store) {
      const savedStep = store.get(STORE_STEP, 0);
      if (typeof savedStep === 'number' && savedStep >= 0 && savedStep < steps.length) {
        start = savedStep;
      }
    }

    const root = findRoot();
    root.replaceChildren();
    root.classList.add('wk');

    // 语义护栏：从游戏骨架复制过来时会连 review-panel.js 一起带过来。
    // 图解没有输赢，复盘面板在这里只会是一句空话，不如直接提示删掉。
    if (window.GameReview) {
      console.warn(
        '[walk-shell] 图解页不需要复盘面板（没有输赢就没有「你这局 vs 换个做法」）。' +
        '请从页面里移除 shared/review-panel.js 和 review-panel.css。'
      );
    }

    const header = el('header', 'wk-head');
    header.append(
      el('div', 'wk-kicker', (config.kicker || '图解') + ' · ' + steps.length + ' 步'),
      el('h1', 'wk-title', config.title || document.title),
      el('p', 'wk-lede', config.lede || '')
    );

    const flowEl = el('nav', 'wk-flow');
    flowEl.setAttribute('aria-label', '流程步骤');

    const card = el('section', 'wk-card');
    const cardHead = el('div', 'wk-card-head');
    const noEl = el('span', 'wk-stepno');
    const titleWrap = el('div', 'wk-title-wrap');
    const stepTitleEl = el('h2', 'wk-step-title');
    const captionEl = el('p', 'wk-caption');
    titleWrap.append(stepTitleEl, captionEl);
    cardHead.append(noEl, titleWrap);

    const stageEl = el('div', 'wk-stage');
    card.append(cardHead, stageEl);

    const paramsEl = el('div', 'wk-params');
    paramsEl.setAttribute('aria-live', 'polite');

    const nav = el('div', 'wk-nav');
    const prevBtn = el('button', 'wk-btn', '← 上一步');
    prevBtn.type = 'button';
    const countEl = el('span', 'wk-count');
    countEl.setAttribute('aria-live', 'polite');
    const nextBtn = el('button', 'wk-btn is-primary', '下一步 →');
    nextBtn.type = 'button';
    nav.append(prevBtn, countEl, nextBtn);

    const hint = el('p', 'wk-kbd-hint', '提示：也可以按键盘 ← → 翻页，点上方流程图的任意一步直接跳过去。');

    root.append(header, flowEl, card, paramsEl, nav, hint);

    ctx = {
      id: config.id,
      steps,
      specs,
      values,
      index: Math.max(0, start),
      loop: Boolean(config.loop),
      store,
      flowEl,
      stageEl,
      paramsEl,
      noEl,
      stepTitleEl,
      captionEl,
      countEl,
      prevBtn,
      nextBtn,
    };

    ctx.api = {
      values,
      el,
      store,
      redraw,
      set: (id, value) => setValue(id, value),
      get index() { return ctx.index; },
      get total() { return ctx.steps.length; },
      get step() { return ctx.steps[ctx.index]; },
    };

    prevBtn.addEventListener('click', () => goTo(ctx.index - 1));
    nextBtn.addEventListener('click', () => goTo(ctx.index + 1));
    document.addEventListener('keydown', onKeydown);

    renderFlow();
    renderHead();
    renderParams();
    redraw();

    return ctx.api;
  }

  window.GameWalk = {
    mount,
    h: el,
    ui,
    get current() { return ctx ? ctx.api : null; },
  };
})();
