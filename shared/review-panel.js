/* ==========================================================================
   review-panel.js —— 所有游戏共用的复盘面板
   --------------------------------------------------------------------------
   它解决的问题：普通游戏结束时只说「你得了 800 分」，玩家带着手感离开；
   复盘面板说的是「这个分数是怎么来的，换个做法会变成什么样」。

   结构固定五段，顺序不许改（见 doc/DEV-GUIDE.md §2.5）：
     ① 判定  一句话告诉你落在哪个区间
     ② 指标  把「用 X 换了 Y」数字化
     ③ 归因  指到具体某一轮 / 某一题 / 某一步
     ④ 反事实 同一套规则，把另一种做法也跑一遍（必须项）
     ⑤ 建议  只给一条，列五条等于没建议

   为什么第 ④ 段是硬要求：前三段只能让玩家「知道」，只有反事实能让他「信服」。
   没有对照，指标就只是数字；有了对照，玩家才能自己想出「原来我亏在这里」。
   缺这一段时组件会在页面上显示显式告警，而不是悄悄少一块。

   游戏侧零 markup：直接调 GameReview.show(spec)，宿主节点由本文件创建。
   「忘记加复盘」和「忘记调用」在结构上都不该发生——这是共享层存在的理由。
   ========================================================================== */

(function () {
  'use strict';

  const HOST_ID = 'gh-review';

  /** 五段里必须有内容的三段：没有判定就没有结论，没有反事实就没有理解。 */
  const REQUIRED = ['verdict', 'counterfactual', 'advice'];

  let host = null;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  /** 宿主节点：页面写了 #gh-review 就用它，没写就补一个到 main 末尾。 */
  function ensureHost() {
    if (host && document.body.contains(host)) return host;

    host = document.getElementById(HOST_ID);
    if (!host) {
      host = node('section', 'ghr-panel');
      host.id = HOST_ID;
      host.setAttribute('aria-label', '本局复盘');
      const main = document.querySelector('main') || document.body;
      main.append(host);
    } else if (!host.classList.contains('ghr-panel')) {
      host.classList.add('ghr-panel');
    }
    return host;
  }

  // ------------------------------------------------------------------ ① 判定

  function buildHead(spec) {
    const head = node('div', 'ghr-head');
    head.append(node('span', 'ghr-title', spec.title || '复盘'));
    if (spec.meta) head.append(node('span', 'ghr-meta', spec.meta));
    return head;
  }

  // ------------------------------------------------------------------ ② 指标

  function buildMetrics(metrics) {
    if (!Array.isArray(metrics) || !metrics.length) return null;
    const grid = node('div', 'ghr-metrics');
    metrics.slice(0, 4).forEach((metric) => {
      const cell = node('div', 'ghr-metric' + (metric.strong ? ' is-strong' : ''));
      cell.append(
        node('span', null, metric.label),
        node('b', null, String(metric.value))
      );
      grid.append(cell);
    });
    return grid;
  }

  // ------------------------------------------------------- ③ 归因（两种形态）

  function buildTable(attribution) {
    const wrap = node('div', 'ghr-table-wrap');
    const table = node('table', 'ghr-table');

    const thead = node('thead');
    const headRow = node('tr');
    (attribution.columns || []).forEach((column) => headRow.append(node('th', null, column)));
    thead.append(headRow);

    const tbody = node('tbody');
    const highlight = new Set(attribution.highlightRows || []);
    (attribution.rows || []).forEach((cells, index) => {
      const tr = node('tr', highlight.has(index) ? 'is-best' : '');
      cells.forEach((cell) => tr.append(node('td', null, String(cell))));
      tbody.append(tr);
    });

    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  function buildList(attribution) {
    const list = node('div', 'ghr-list');
    (attribution.items || []).forEach((item) => {
      const tone = item.tone || 'none';
      const row = node('div', 'ghr-item is-' + tone);
      row.append(
        node('span', 'ghr-mark', item.mark == null ? '·' : item.mark),
        node('span', null, item.text)
      );
      list.append(row);
    });
    return list;
  }

  function buildAttribution(attribution) {
    if (!attribution) {
      console.warn('[review-panel] 缺少 attribution：归因层能把「输在哪」指到具体一步，建议补上。');
      return null;
    }

    const section = node('div', 'ghr-section');
    section.append(node('h3', 'ghr-label', attribution.label || '归因'));
    section.append(
      attribution.kind === 'list' ? buildList(attribution) : buildTable(attribution)
    );
    if (attribution.note) section.append(node('p', 'ghr-note', attribution.note));
    return section;
  }

  // ------------------------------------------------------------ ④ 反事实

  /**
   * 条形对照。value 只决定长度，text 决定显示什么——
   * 因为不同游戏量纲不同（加速比、分数、格数），组件不该替游戏做格式化。
   */
  function buildBars(counterfactual) {
    const bars = Array.isArray(counterfactual.bars) ? counterfactual.bars : [];
    const max = Math.max(...bars.map((bar) => Math.abs(Number(bar.value) || 0)), 0);

    const wrap = node('div', 'ghr-bars');
    bars.forEach((bar) => {
      const row = node(
        'div',
        'ghr-bar-row' + (bar.best ? ' is-best' : '') + (bar.mine ? ' is-mine' : '')
      );

      const track = node('span', 'ghr-bar-track');
      const fill = node('i');
      // 值为 0 的档位保留 2% 的细线：没有它，玩家会以为这一行没渲染出来
      const ratio = max > 0 ? Math.abs(Number(bar.value) || 0) / max : 0;
      fill.style.width = Math.max(2, ratio * 100) + '%';
      track.append(fill);

      row.append(
        node('span', 'ghr-bar-label', bar.label),
        track,
        node('span', 'ghr-bar-value', bar.text)
      );
      wrap.append(row);
    });
    return wrap;
  }

  function buildCounterfactual(counterfactual) {
    if (!counterfactual) return null;

    const section = node('div', 'ghr-section');
    section.append(node('h3', 'ghr-label', counterfactual.label || '反事实'));

    // 先解释「这一组数字是怎么算出来的」，再给图：
    // 玩家看到的每条对照曲线，都必须是同一套规则、同一个种子跑出来的，否则对照无效。
    if (counterfactual.note) section.append(node('p', 'ghr-note', counterfactual.note));
    section.append(buildBars(counterfactual));
    if (counterfactual.footer) section.append(node('p', 'ghr-note', counterfactual.footer));
    return section;
  }

  // ------------------------------------------------------------------ 组装

  function show(spec) {
    const panel = ensureHost();
    const data = spec || {};

    REQUIRED.forEach((key) => {
      if (!data[key]) {
        console.error(
          `[review-panel] 复盘缺少必填字段 ${key}。` +
          '五段结构见 doc/DEV-GUIDE.md §2.5，其中反事实是不可省的。'
        );
      }
    });

    const frag = document.createDocumentFragment();
    frag.append(buildHead(data));
    frag.append(node('p', 'ghr-verdict', data.verdict || '（缺少判定文案）'));

    const metrics = buildMetrics(data.metrics);
    if (metrics) frag.append(metrics);

    const attribution = buildAttribution(data.attribution);
    if (attribution) frag.append(attribution);

    const counterfactual = buildCounterfactual(data.counterfactual);
    if (counterfactual) frag.append(counterfactual);
    else frag.append(node('p', 'ghr-missing',
      '这个游戏还没有提供反事实对照。按开发规范，复盘至少要有一层「换个做法会怎样」，' +
      '否则前四段只是把分数换了个说法。'));

    if (data.advice) frag.append(node('p', 'ghr-advice', data.advice));

    panel.replaceChildren(frag);
    panel.hidden = false;

    if (data.scroll !== false) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return panel;
  }

  function hide() {
    if (!host) return;
    host.hidden = true;
    host.replaceChildren();
  }

  window.GameReview = {
    show,
    hide,
    element: ensureHost,
  };
})();
