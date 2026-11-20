/* ==========================================================================
   Agent 经典循环 · 图解脚本
   --------------------------------------------------------------------------
   职责：用一个具体提问走完一整轮 Agent 循环，逐步摊开上下文怎么涨、
   什么时候该压、压错了会丢什么。
   不负责：导航、参数控件、步骤记忆 —— 那些在 shared/walk-shell.js 里。

   token 数是按一个 7B 级别模型的实际量级估的（系统提示 620、三个工具定义 1140、
   一段文档节选 1180），不是随手编的整数。它们加起来必须真的会超过预算，
   否则「上下文管理」那一步永远触发不了，整条链路就白讲了。
   ========================================================================== */

(function () {
  'use strict';

  const H = window.GameWalk.h;
  const UI = window.GameWalk.ui;
  const note = UI.note;
  const bars = UI.bars;
  const flow = UI.flow;
  const label = UI.label;

  function stat(host, name, value, tone) {
    let grid = host.lastElementChild;
    if (!grid || !grid.classList.contains('wk-stats')) {
      grid = UI.stats(host, []);
    }
    return UI.statCard(grid, { label: name, value, tone });
  }

  // ---------------------------------------------------------------- 数据

  const QUESTION = '上周三例会上定的数据库方案是什么？为什么没选另一个？';

  /** 进循环之前，上下文里已经有的东西。这五项就是「一句话提问的真实成本」。 */
  const BASE_PARTS = [
    { id: 'system', label: '系统提示', tokens: 620 },
    { id: 'tools', label: '工具定义（3 个）', tokens: 1140 },
    { id: 'profile', label: '用户画像 / 长期记忆', tokens: 900 },
    { id: 'history', label: '历史对话（前 2 轮）', tokens: 1600 },
    { id: 'question', label: '本次提问', tokens: 32 },
  ];

  const BASE_TOKENS = BASE_PARTS.reduce((sum, part) => sum + part.tokens, 0);

  /** 循环里逐步追加的部分。工具结果才是真正撑爆上下文的东西。 */
  const COST = {
    thought1: 210,
    action1: 120,
    obs1: 480,
    thought2: 230,
    chunk: 780,
    action2: 240,
    obs2: 1180,
  };

  /**
   * 循环内的追加顺序，必须和步骤顺序完全一致。
   * 这份表是唯一的口径来源——每个步骤都只问「到这里为止累计多少」，
   * 不许自己手写加法。第一版在三个步骤里各写了一次硬编码总数，
   * 结果把 top-k 拖大之后，三屏显示的是三个互相矛盾的累计值。
   */
  const FLOW_COST = [
    { key: 'thought1', tokens: () => COST.thought1 },
    { key: 'action1', tokens: () => COST.action1 },
    { key: 'obs1', tokens: () => COST.obs1 },
    {
      key: 'rag',
      tokens: (values) => (values.rag ? Number(values.ragTopK) * COST.chunk : 0),
    },
    { key: 'thought2', tokens: () => COST.thought2 },
    { key: 'action2', tokens: () => COST.action2 },
    { key: 'obs2', tokens: () => COST.obs2 },
  ];

  const TOOLS = [
    { name: 'calendar.search', desc: '按时间范围查日历' },
    { name: 'doc.search', desc: '在团队文档库里检索' },
    { name: 'db.query', desc: '查业务数据库' },
  ];

  // ---------------------------------------------------------------- 纯函数

  function baseTokens() {
    return BASE_TOKENS;
  }

  /** 走到某一步为止，上下文累计多少 token（含开头那批基础材料）。 */
  function cumulative(values, upToKey) {
    let sum = BASE_TOKENS;
    for (let i = 0; i < FLOW_COST.length; i += 1) {
      sum += FLOW_COST[i].tokens(values);
      if (FLOW_COST[i].key === upToKey) break;
    }
    return sum;
  }

  /** 走完整轮循环后，上下文里一共有多少 token。 */
  function loopTokens(values) {
    return cumulative(values, 'obs2');
  }

  function compressOf(values) {
    const budget = Number(values.budget);
    const used = loopTokens(values);
    const over = used > budget;
    const strategy = values.compress;

    // 三种策略省下的量和丢掉的信息是不一样的，这里必须分开算：
    //   summary   把召回的几段压成一段摘要，省得多，但对比理由这类细节最先被抹掉
    //   drop-oldest 丢掉最旧的两轮历史，省得少，但这段历史本来就用不上
    //   none      什么都不做，请求会被服务端按长度硬截断，砍在哪里完全不可控
    const chunks = values.rag ? Number(values.ragTopK) * COST.chunk : 0;
    const summarySaving = Math.round(chunks * 0.74);
    const dropSaving = 1600;

    let after = used;
    let detailLost = false;
    let verdict = '';
    let tone = 'ok';
    // 「压缩后」这个说法对「不处理」是不成立的：那一条不是压缩，是被服务端硬截断。
    // 第一版把三种策略统一写成「压缩后 → 达标」，结果在「不处理」下显示「达标」，
    // 和下面那句「很可能把工具返回砍掉半截」自相矛盾。
    let afterLabel = '压缩后';
    let resultText = '没超';
    let resultTone = 'strong';

    if (!over) {
      verdict = '预算还够，这一段什么都不用做。把预算调到 ' + Math.round(used) +
        ' 以下，同一段流程就会开始压缩。';
      resultText = '无需压缩';
      resultTone = '';
      return { budget, used, after, over, detailLost, verdict, tone, strategy, afterLabel, resultText, resultTone };
    }

    if (strategy === 'summary') {
      after = used - summarySaving;
      detailLost = true;
      tone = 'bad';
      verdict = '压成摘要省了 ' + summarySaving + ' token，但摘要抹掉的正是「为什么没选另一个」' +
        '那半句——你问的是原因，摘要留下的全是结论。';
    } else if (strategy === 'drop-oldest') {
      after = used - dropSaving;
      tone = 'ok';
      verdict = '丢掉最旧的两轮历史，省了 ' + dropSaving + ' token。这次赌对了：' +
        '上一轮聊的是排期，跟本问无关。换个问题就不一定了。';
    } else {
      after = used - Math.round(used * 0.6);
      detailLost = true;
      tone = 'bad';
      afterLabel = '硬截断后';
      resultText = '被硬砍掉';
      resultTone = 'warn';
      verdict = '什么都不做，下一轮请求会超长。服务端只能从头或从尾硬截断，' +
        '砍在哪里你说了不算——很可能把工具刚返回的结果砍掉半截。';
    }

    if (strategy !== 'none' && after > budget) {
      resultText = '仍然超';
      resultTone = 'warn';
    }

    return { budget, used, after, over, detailLost, verdict, tone, strategy, afterLabel, resultText, resultTone };
  }

  /** 最终回答能不能落地：结论要不要紧，理由要不要紧，是两件事。 */
  function answerOf(values) {
    const compress = compressOf(values);
    const turns = Number(values.maxTurns);
    const rag = Boolean(values.rag);

    const hasConclusion = rag && turns >= 2;
    // 理由来自「对比」那一段文档，只有检索到、且没被摘要抹掉、且轮数够才拿得到
    const hasReason = hasConclusion && turns >= 3 && !compress.detailLost;

    return { hasConclusion, hasReason, compress, turns, rag };
  }

  // ------------------------------------------------------------------ 步骤

  const steps = [
    {
      id: 'question',
      title: '用户提问',
      short: '提问',
      group: '起步',
      caption: '一句话，但里面藏了三件事：先要定位「上周三」是哪天，再去翻纪要，最后还要说清对比理由。',
      draw(stage) {
        const bubble = H('div', 'ag-bubble');
        bubble.append(H('span', 'ag-bubble-role', '用户'), H('p', 'ag-bubble-text', QUESTION));
        stage.append(bubble);

        stat(stage, '这句话的字符数', String([...QUESTION].length));
        stat(stage, '要凑齐的信息', '3 件', 'strong');
        stat(stage, '当前上下文里的 token', '32', '');

        note(stage,
          '模型自己不知道「上周三」是哪一天，也没有你团队的会议记录。' +
          '这两件事必须靠工具和检索补上——这就是为什么这条链路不能只有一次前向。' +
          '顺带一提：此刻整个上下文里，模型真正收到的问题只有 32 个 token，' +
          '下一步你会看到剩下的几千个是什么。');
      },
    },

    {
      id: 'assemble',
      title: '组装提示词',
      short: '组装',
      group: '起步',
      caption: '把系统提示、工具定义、记忆、历史和这次提问拼成一个数组。这一步没有任何模型参与，全是字符串拼接。',
      draw(stage) {
        flow(stage, [
          { title: '系统提示', sub: '角色 + 规则' },
          { title: '工具定义', sub: TOOLS.length + ' 个 schema' },
          { title: '记忆', sub: '用户画像' },
          { title: '历史', sub: '前 2 轮' },
          { title: '提问', sub: '32 token', tone: 'accent' },
        ]);

        bars(stage, BASE_PARTS.map((part) => ({
          label: part.label,
          value: part.tokens,
          text: String(part.tokens),
          hit: part.id === 'question',
        })));

        const question = BASE_PARTS.find((p) => p.id === 'question').tokens;
        const tools = BASE_PARTS.find((p) => p.id === 'tools').tokens;

        stat(stage, '合计', String(BASE_TOKENS) + ' token', 'strong');
        stat(stage, '工具定义占比', pct(tools / BASE_TOKENS));
        stat(stage, '提问占比', pct(question / BASE_TOKENS));
        stat(stage, '固定开销', String(BASE_TOKENS - question) + ' token', 'warn');

        note(stage,
          '「一句话提问」的真实成本是 ' + BASE_TOKENS + ' 个 token，' +
          '其中用户写的那句话占 ' + pct(question / BASE_TOKENS) + '。' +
          '工具定义是一大块固定开销——每加一个 MCP 工具，这块都会变长，' +
          '所以工具多的 Agent 上下文总是很紧张，而且这部分内容对每一句话都要重复发一遍。');
      },
    },

    {
      id: 'budget',
      title: '装入上下文',
      short: '装上下文',
      group: '起步',
      caption: '组装完之后先数一遍 token，跟窗口预算比一下。这一步不做，后面所有压缩都无从谈起。',
      params: ['budget'],
      draw(stage, api) {
        const budget = Number(api.values.budget);
        const used = baseTokens();
        const ratio = used / budget;

        bars(stage, [
          { label: '已装入', value: used, text: used + ' token', hit: used <= budget },
          { label: '预算上限', value: budget, text: budget + ' token' },
        ]);

        stat(stage, '已用', used + ' token', 'strong');
        stat(stage, '预算', budget + ' token');
        stat(stage, '占用率', pct(ratio), ratio > 0.9 ? 'warn' : '');
        stat(stage, '剩余', Math.max(0, budget - used) + ' token');

        UI.verdict(stage, used <= budget
          ? '还装得下。但注意：这时候只是「把开场材料放进去」，工具还没调，结果还没回来。'
          : '一开场就已经超了。真实系统在这里只有两条路：先压缩，或者直接报错拒绝。',
          used <= budget ? 'ok' : 'bad');

        note(stage,
          '把预算拖到 ' + BASE_TOKENS + ' 以下，你会看到这一步就已经爆了——' +
          '连提问都还没处理。这就是为什么长系统提示的 Agent 在小窗口模型上根本跑不起来。');
      },
    },

    {
      id: 'thought1',
      title: 'Thought ①',
      short: 'Thought ①',
      group: '循环',
      caption: '模型先输出一段思考，再决定做什么。注意：这段思考和后面的工具调用一样，都只是它生成的文本。',
      draw(stage) {
        const box = H('div', 'ag-thought');
        box.append(
          H('span', 'ag-thought-tag', 'Thought'),
          H('p', null, '用户说「上周三」，我需要先把日期确定下来。我的知识里没有当前日期，' +
            '日历工具能查。先查上周一到上周五的日程，找到那次例会。')
        );
        stage.append(box);

        flow(stage, [
          { title: '当前消息列表', sub: BASE_TOKENS + ' token' },
          { title: '模型前向一次', sub: '生成思考' },
          { title: '思考追加进列表', sub: '+' + COST.thought1 + ' token', tone: 'accent' },
        ]);

        stat(stage, '这一步新增', COST.thought1 + ' token');
        stat(stage, '上下文累计', (BASE_TOKENS + COST.thought1) + ' token', 'strong');

        note(stage,
          '思考也要占上下文，而且会一直留着。有些实现会在下一轮把它摘掉' +
          '（只保留工具调用和结果），这就是「reasoning 摘要」在工程上的动机之一：' +
          '思考有用，但每一轮都完整保留，几十轮之后上下文全被它占满。');
      },
    },

    {
      id: 'action1',
      title: 'Action ①',
      short: 'Action ①',
      group: '循环',
      caption: '模型输出一个工具调用请求。它并没有「调用」任何东西——它只是生成了一段符合 schema 的文本。',
      draw(stage) {
        flow(stage, [
          { title: '选工具', sub: TOOLS[0].name },
          { title: '填参数', sub: 'range / 关键词' },
          { title: '输出 JSON', sub: '一段文本', tone: 'accent' },
        ]);

        const code = H('pre', 'ag-code');
        code.textContent = JSON.stringify({
          tool: 'calendar.search',
          args: { range: '上周一 ~ 上周五', keyword: '例会' },
        }, null, 2);
        stage.append(code);

        stat(stage, '新增 token', '约 120');
        stat(stage, '执行方', '外部运行时', 'strong');
        stat(stage, '模型是否知道结果', '还不知道');

        note(stage,
          '这是 Agent 最容易被说错的一步。模型没有执行权限，它输出的是一个结构化请求；' +
          '真正去查日历的是外面那层代码。所以「Agent 能删库」这件事的边界，' +
          '不在模型的自觉，而在你给运行时开了什么权限。');
      },
    },

    {
      id: 'obs1',
      title: '观察 ①',
      short: '观察 ①',
      group: '循环',
      caption: '运行时执行工具，把返回结果原样塞回消息列表。上下文从这里开始真正变胖。',
      draw(stage, api) {
        const code = H('pre', 'ag-code');
        code.textContent = [
          '[',
          '  { "time": "周二 10:00", "title": "需求评审" },',
          '  { "time": "周三 14:00", "title": "架构评审" },',
          '  { "time": "周四 16:30", "title": "周会" }',
          ']',
        ].join('\n');
        stage.append(code);

        bars(stage, [
          { label: 'Thought ①', value: COST.thought1, text: COST.thought1 + '' },
          { label: 'Action ①', value: 120, text: '120' },
          { label: '观察 ①（工具返回）', value: COST.obs1, text: COST.obs1 + '', hit: true },
        ]);

        stat(stage, '这一次工具返回', COST.obs1 + ' token', 'warn');
        stat(stage, '上下文累计', cumulative(api.values, 'obs1') + ' token');
        stat(stage, '信息价值', '只有一行有用', 'warn');

        note(stage,
          '三场会议里只有一条有用，但三条全进了上下文。真实工具返回的 JSON 常常是几十个字段，' +
          '你只需要其中两个——这就是为什么成熟的做法是「工具侧裁剪」：让工具自己只返回关键字段，' +
          '而不是返回完整结构再指望上下文管理器去压。');
      },
    },

    {
      id: 'rag',
      title: 'RAG 检索',
      short: 'RAG',
      group: '循环',
      caption: '会议找到了，但纪要里的内容不在上下文里。检索就是「把相关的几段文字捞出来，塞进去」。',
      params: ['rag', 'ragTopK'],
      draw(stage, api) {
        const enabled = Boolean(api.values.rag);
        const topK = Number(api.values.ragTopK);

        if (!enabled) {
          UI.verdict(stage,
            '检索被关掉了。模型手里只有那三场会议的标题——它不知道「架构评审」里定了什么。' +
            '但它不会因此说「我不知道」，它会顺着语气编一个听起来很像的结论。这是最危险的一种失败。',
            'bad');
          stat(stage, '注入的段落', '0 段');
          stat(stage, '注入 token', '0');
          stat(stage, '模型会怎么答', '编一个', 'warn');
          note(stage,
            '把开关重新打开，看下面两屏的差别。关掉检索不是「答不出来」，是「答得很像但全错」——' +
            '这也是所有 RAG 评测里最需要防的情形。');
          return;
        }

        const chunks = [
          { id: 'c1', title: '架构评审纪要 · 第 3 段', score: 0.91, text: '数据库最终选 PostgreSQL，理由是团队已有运维经验……' },
          { id: 'c2', title: '架构评审纪要 · 第 7 段', score: 0.84, text: '未选 MySQL 的原因：分区表在千万级数据下维护成本高……' },
          { id: 'c3', title: '需求评审纪要 · 第 2 段', score: 0.62, text: '本周排期确认，接口联调顺延到下周……' },
          { id: 'c4', title: '周会纪要 · 第 5 段', score: 0.41, text: '新人入职安排，导师分配……' },
          { id: 'c5', title: '架构评审纪要 · 第 12 段', score: 0.33, text: '缓存层暂定 Redis 集群，后续再评估……' },
        ].slice(0, Math.max(1, topK));

        const rank = H('div', 'ag-chunks');
        chunks.forEach((chunk, i) => {
          const card = H('div', 'ag-chunk' + (i < 2 ? ' is-kept' : ''));
          const head = H('div', 'ag-chunk-head');
          head.append(
            H('span', 'ag-chunk-rank', '#' + (i + 1)),
            H('b', null, chunk.title),
            H('span', 'ag-chunk-score', chunk.score.toFixed(2))
          );
          const bar = H('span', 'ag-chunk-bar');
          const fill = H('i');
          fill.style.width = (chunk.score * 100).toFixed(0) + '%';
          bar.append(fill);
          card.append(head, bar, H('p', 'ag-chunk-text', chunk.text));
          rank.append(card);
        });
        stage.append(rank);

        const injected = chunks.length * COST.chunk;
        stat(stage, '召回段数', chunks.length + ' 段', 'strong');
        stat(stage, '注入 token', String(injected), injected > 2000 ? 'warn' : '');
        stat(stage, '真正相关的', '2 段');
        stat(stage, '上下文累计', String(cumulative(api.values, 'rag')));

        note(stage,
          '注意召回的排名和相关性：前两段才真的回答了问题，第三段只是字面相似。' +
          '把 top-k 拖到 5，你会多注入两个干扰段落——检索不是召回越多越好，' +
          '多召回一段就多 ' + COST.chunk + ' 个 token，也多个分散注意力的噪声。');
      },
    },

    {
      id: 'thought2',
      title: 'Thought ②',
      short: 'Thought ②',
      group: '循环',
      caption: '看到了纪要，但只有结论。模型自己判断出还缺一块，再走一轮。',
      draw(stage, api) {
        const enabled = Boolean(api.values.rag);
        const box = H('div', 'ag-thought');
        box.append(
          H('span', 'ag-thought-tag', 'Thought'),
          H('p', null, enabled
            ? '纪要里写明了选 PostgreSQL。第二段提到没选 MySQL，但只有半句——' +
              '我要找完整的那段对比评估，才能说清理由。再查一次文档库。'
            : '进度：没人告诉过我这个方案是什么。我应该直接给一个听起来合理的答案，' +
              '反正用户不会去核对。')
        );
        stage.append(box);

        stat(stage, '这一步新增', COST.thought2 + ' token');
        if (!enabled) {
          stat(stage, '模型此刻的判断依据', '没有', 'warn');
          UI.verdict(stage,
            '这一屏是关掉检索后才看得到的：模型没有依据，却依然会往下走。' +
            '它不会停下来问「我查不到」，因为提示词里没有那样一条规则。',
            'bad');
        }

        note(stage,
          '「还缺什么」这个判断是模型自己做的，不是代码写的 if-else。' +
          '所以 Agent 的轮数是不确定的——同一句话，有时一轮就够，有时要五轮。' +
          '这也是为什么必须有「最大轮数」这个硬保险。');
      },
    },

    {
      id: 'action2',
      title: 'Action ②',
      short: 'Action ②',
      group: '循环',
      caption: '第二次调工具。这次是文档库，关键词直接来自上一屏的判断。',
      draw(stage, api) {
        flow(stage, [
          { title: '选工具', sub: TOOLS[1].name },
          { title: '填参数', sub: '「数据库 弃用 对比」' },
          { title: '输出 JSON', sub: '一段文本', tone: 'accent' },
        ]);

        const code = H('pre', 'ag-code');
        code.textContent = JSON.stringify({
          tool: 'doc.search',
          args: { q: '数据库 选型 弃用 对比 评估', space: '架构组', limit: 2 },
        }, null, 2);
        stage.append(code);

        stat(stage, '已用轮数', '2 轮（上限见「循环判定」）');
        stat(stage, '上下文累计', cumulative(api.values, 'action2') + ' token');

        note(stage,
          '关键词是模型从「还缺什么」推出来的，不是你写死的。' +
          '这意味着同一段代码，换一个问题就会发出完全不同的请求——' +
          '所以工具的参数校验必须做在运行时那一侧，不能信任模型一定填对。');
      },
    },

    {
      id: 'obs2',
      title: '观察 ②',
      short: '观察 ②',
      group: '循环',
      caption: '这两段文档才是真正撑爆上下文的东西——一次就 1180 个 token。',
      draw(stage, api) {
        const code = H('pre', 'ag-code is-tall');
        code.textContent = [
          '【第 1 段】数据库选型对比评估（节选）',
          '候选：PostgreSQL / MySQL / MongoDB。评估维度：',
          '事务一致性、分区表维护成本、团队既有运维经验、',
          '迁移工期、社区生态。评分表见附录 A，共 5 页……',
          '',
          '【第 2 段】弃用 MySQL 的原因（节选）',
          '千万级数据量下分区表的在线维护成本偏高，',
          '需要停机窗口；团队已有 3 套 PG 集群，运维熟悉……',
        ].join('\n');
        stage.append(code);

        const total = cumulative(api.values, 'obs2');
        const toolTokens = COST.obs1 + COST.obs2 +
          (api.values.rag ? Number(api.values.ragTopK) * COST.chunk : 0);

        stat(stage, '这一次新增', COST.obs2 + ' token', 'warn');
        stat(stage, '上下文累计', total + ' token', 'warn');
        stat(stage, '工具返回占比', pct(toolTokens / total), 'warn');

        note(stage,
          '把几处工具返回加起来一共 ' + toolTokens + ' token，占整个上下文的 ' +
          pct(toolTokens / total) + '，而其中真正进到最终回答里的可能只有几十个字。' +
          '下一步就是处理这件事的地方。');
      },
    },

    {
      id: 'manage',
      title: '上下文管理',
      short: '上下文管理',
      group: '管理',
      caption: '预算不够了。压缩不是「把文字变短」，是「决定牺牲哪一段信息」——而这是个有代价的选择。',
      params: ['budget', 'compress'],
      draw(stage, api) {
        const info = compressOf(api.values);

        bars(stage, [
          { label: '压缩前', value: info.used, text: String(info.used) },
          { label: '预算上限', value: info.budget, text: String(info.budget) },
          {
            label: info.afterLabel,
            value: Math.max(0, info.after),
            text: String(Math.max(0, info.after)),
            hit: info.over && info.strategy !== 'none' && info.after <= info.budget,
          },
        ]);

        stat(stage, '已用', info.used + ' token', 'strong');
        stat(stage, '预算', info.budget + ' token');
        stat(stage, '超出', info.over ? '+' + (info.used - info.budget) : '没超');
        stat(stage, '压缩后是否超预算', info.resultText, info.resultTone);

        UI.verdict(stage, info.verdict, info.tone);

        note(stage,
          '三种策略没有通用最优，取决于「你下一步要用哪一段」。' +
          '这一问要的是原因，所以摘要恰好把要用的东西抹掉了；' +
          '如果这一问是「会上还定了别的什么」，结论就反过来了。' +
          '真实系统里这一步通常是组合拳：先丢历史，再压工具返回，最后才动系统提示——' +
          '因为系统提示里往往写着「不许编造」这类不能丢的规则。');
      },
    },

    {
      id: 'loop-check',
      title: '循环判定',
      short: '循环判定',
      group: '管理',
      caption: '要不要再来一轮？这里有三个独立的退出条件，任何一个满足都会停。',
      params: ['maxTurns'],
      draw(stage, api) {
        const turns = Number(api.values.maxTurns);

        flow(stage, [
          { title: '信息够了？', sub: '模型自己判断' },
          { title: '轮数到顶？', sub: '上限 ' + turns },
          { title: '预算耗尽？', sub: '压缩也救不回来' },
        ], '或');

        const enough = turns >= 3;

        stat(stage, '本问实际需要', '3 轮', 'strong');
        stat(stage, '你的上限', turns + ' 轮', turns < 3 ? 'warn' : '');
        stat(stage, '结果', enough ? '正常退出' : '被上限中断', enough ? 'strong' : 'warn');

        UI.verdict(stage, enough
          ? '三轮走完，模型判断信息够了，主动输出。这是唯一的「正常退出」。'
          : '轮数上限比实际需要的轮数还小，循环在第二轮就被掐断了。' +
            '注意它不是报错退出——它会带着半截信息硬答，看起来和正常回答一模一样。',
          enough ? 'ok' : 'bad');

        note(stage,
          '三个退出条件里，只有第一个是「任务完成」。另外两个都是异常出口，' +
          '但工程上不能没有：没有轮数上限，模型可能在一件事上反复调工具；' +
          '没有预算上限，请求会直接被服务端拒绝。');
      },
    },

    {
      id: 'answer',
      title: '最终回答',
      short: '回答',
      group: '收尾',
      caption: '最后一轮的前向输出就是给用户的答案。前面 12 步的全部代价，都落在这一屏上。',
      params: ['rag', 'compress', 'maxTurns', 'budget'],
      draw(stage, api) {
        const info = answerOf(api.values);

        let text;
        if (!info.hasConclusion) {
          text = '会上定的是 MySQL 方案，因为 PostgreSQL 的分区表维护成本太高。';
        } else if (!info.hasReason) {
          text = '上周三的架构评审定的是 PostgreSQL。';
        } else {
          text = '上周三架构评审定的是 PostgreSQL。没选 MySQL 的原因是：' +
            '千万级数据量下分区表的在线维护成本偏高，需要停机窗口；' +
            '而团队已有 3 套 PG 集群，运维更熟悉。';
        }

        const bubble = H('div', 'ag-bubble is-answer');
        bubble.append(H('span', 'ag-bubble-role', 'Agent'), H('p', 'ag-bubble-text', text));
        stage.append(bubble);

        stat(stage, '结论正确', info.hasConclusion ? '是' : '否', info.hasConclusion ? 'strong' : 'warn');
        stat(stage, '理由给全', info.hasReason ? '是' : '否', info.hasReason ? 'strong' : 'warn');
        stat(stage, '引用来源', info.hasConclusion ? '2 段' : '0 段');
        stat(stage, '上下文峰值', loopTokens(api.values) + ' token');

        if (!info.hasConclusion) {
          UI.verdict(stage,
            '这个回答是编的。方案名说错了，理由却是真的——它把别处的印象拼了上来。' +
            '这种回答比空着更危险，因为它看起来完全可信。',
            'bad');
        } else if (!info.hasReason) {
          // 默认参数（摘要 + 8k 预算）正好走到这一支，所以这里必须给一条明确的出口，
          // 否则读者会以为「这图解讲到最后也没给个完整答案」。
          UI.verdict(stage,
            '结论对了，但你问的第二半没答。真实使用中这类回答最容易被放过：' +
            '用户看到前半句正确，就默认后半句也没问题。' +
            '回到「上下文管理」把压缩策略改成「丢最旧的历史」，再回来看这一屏。',
            'bad');
        } else {
          UI.verdict(stage,
            '结论和理由都到位，而且能指回具体来源。走通这条链路的关键不是模型更强，' +
            '是每一步该有的信息都到位了、该丢的都没丢。',
            'ok');
        }

        note(stage,
          '回头看这一整轮：真正决定答案质量的，是三个工程决定——' +
          '检索开没开、压缩策略选得对不对、轮数上限够不够。模型本身一次都没换过。' +
          '这也是 Agent 调优的常态：改的都是外面这层，不是模型。');
      },
    },
  ];

  function pct(v) {
    return (v * 100).toFixed(0) + '%';
  }

  // ---------------------------------------------------------------- 挂载

  window.GameWalk.mount({
    id: 'agent-loop',
    title: 'Agent 经典循环',
    kicker: '图解',
    lede: '用一个具体的提问走完一整轮：模型想什么、调什么、上下文怎么被撑爆、最后凭什么给出答案。',
    loop: true,
    params: [
      {
        id: 'budget',
        label: '上下文预算',
        type: 'range',
        min: 4096,
        max: 32768,
        step: 1024,
        value: 8192,
        format: (v) => (Number(v) / 1024).toFixed(0) + 'k',
      },
      { id: 'rag', label: '启用 RAG 检索', type: 'toggle', value: true },
      {
        id: 'ragTopK',
        label: '召回段数',
        type: 'range',
        min: 1,
        max: 5,
        step: 1,
        value: 3,
        format: (v) => v + ' 段',
      },
      {
        id: 'maxTurns',
        label: '最大轮数',
        type: 'range',
        min: 1,
        max: 6,
        step: 1,
        value: 4,
        format: (v) => v + ' 轮',
      },
      {
        id: 'compress',
        label: '压缩策略',
        type: 'select',
        value: 'summary',
        options: [
          { value: 'summary', label: '压成摘要' },
          { value: 'drop-oldest', label: '丢最旧的历史' },
          { value: 'none', label: '不处理' },
        ],
      },
    ],
    steps,
  });
})();
