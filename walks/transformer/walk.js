/* ==========================================================================
   Transformer 全流程 · 图解脚本
   --------------------------------------------------------------------------
   职责：把一条推理链路拆成 12 步，每一步画一张会随着参数变的图。
   不负责：导航、参数控件、步骤记忆 —— 那些在 shared/walk-shell.js 里。

   两个刻意的简化，写在这里以免读者把示意当成真实数值：
     1. 提示词是固定的。允许随意改文本会让后面几步（词表 logits、注意力矩阵）
        全部失去意义，因为那些数字是照着这一段话准备的。
     2. 维度压得很小（嵌入 4~8 维、候选 8 个）。真实词表是 12 万维，
        但 softmax / 归一化 / 采样的算术性质与维度无关，压小不影响结论。
   ========================================================================== */

(function () {
  'use strict';

  const H = window.GameWalk.h;

  // ---------------------------------------------------------------- 数据

  /** 固定提示词。token 里的前导空格是 BPE 的真实行为：词边界也算信息。 */
  const PROMPT = '解释 KV cache 为什么重要';

  const TOKENS = [
    { text: '解释', id: 48231 },
    { text: ' KV', id: 1272 },
    { text: ' cache', id: 8413 },
    { text: ' 为什么', id: 9130 },
    { text: ' 重要', id: 5621 },
  ];

  /** 模型尺寸参照：一个 7B 级别的稠密模型。所有显存/参数量估算都用它。 */
  const D_MODEL = 4096;
  const VOCAB = 128000;
  const BYTES_FP16 = 2;

  /** 下一个 token 的候选与原始 logits（示意）。顺序已按分数从高到低。 */
  const CANDIDATES = [
    { text: '？', logit: 2.6 },
    { text: '，因为', logit: 2.2 },
    { text: '：', logit: 1.9 },
    { text: '它', logit: 1.6 },
    { text: '。', logit: 1.3 },
    { text: '这', logit: 1.0 },
    { text: '在', logit: 0.7 },
    { text: '紫色', logit: 0.3 },
  ];

  /**
   * 注意力原始打分（对称矩阵）。做成固定表而不是随机数，是因为这一屏要讲
   * 「KV 和 cache 互相看」「为什么和重要互相看」这种语义关系——
   * 随机矩阵看起来一样漂亮，但读者学不到任何东西。
   */
  const ATTN_SCORE = [
    [5.0, 3.0, 2.2, 1.8, 1.4],
    [3.0, 4.6, 4.2, 2.0, 1.9],
    [2.2, 4.2, 4.4, 2.4, 2.0],
    [1.8, 2.0, 2.4, 4.2, 3.6],
    [1.4, 1.9, 2.0, 3.6, 4.8],
  ];

  // ---------------------------------------------------------------- 纯函数

  function hash01(seed) {
    let h = 2166136261;
    const text = String(seed);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }

  /** 示意向量：由种子决定，刷新页面不变。 */
  function pseudoVec(seed, dim, scale) {
    const out = [];
    for (let i = 0; i < dim; i += 1) {
      out.push(Math.round((hash01(seed + ':' + i) * 2 - 1) * scale * 10) / 10);
    }
    return out;
  }

  /**
   * 带温度的 softmax。必须先减最大值：T 很小时 exp(z/T) 会直接溢出成 Infinity，
   * Infinity / Infinity 得到 NaN，整屏数字会变成 NaN。
   */
  function softmaxAt(logits, temperature) {
    const t = Math.max(temperature, 0.01);
    const max = Math.max.apply(null, logits);
    const exps = logits.map((z) => Math.exp((z - max) / t));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  }

  /** 一行注意力的权重：按掩码切掉未来位置，再 softmax。 */
  function attentionRow(rowIndex, causal) {
    const row = ATTN_SCORE[rowIndex].slice(0, TOKENS.length);
    const masked = [];
    const kept = [];
    row.forEach((score, j) => {
      if (causal && j > rowIndex) {
        masked.push(j);
        kept.push(-Infinity);
      } else {
        kept.push(score);
      }
    });
    const finite = kept.filter((v) => Number.isFinite(v));
    const max = Math.max.apply(null, finite);
    const exps = kept.map((v) => (Number.isFinite(v) ? Math.exp(v - max) : 0));
    const sum = exps.reduce((a, b) => a + b, 0);
    return {
      weights: exps.map((e) => e / sum),
      masked,
    };
  }

  /**
   * 截断：先 top-k 砍尾巴，再 top-p 按累计概率砍，最后在保留集里重新归一化。
   * 顺序不能反——先 top-p 再 top-k 得到的是另一个分布，实践中两者也很少同时开。
   */
  function truncate(probs, topK, topP) {
    const order = probs
      .map((p, i) => ({ p, i }))
      .sort((a, b) => b.p - a.p);

    const afterK = order.slice(0, Math.max(1, Math.min(topK, order.length)));

    const massAfterK = afterK.reduce((sum, item) => sum + item.p, 0) || 1;
    const kept = [];
    let acc = 0;
    for (const item of afterK) {
      kept.push(item.i);
      acc += item.p / massAfterK;
      if (acc >= topP) break;
    }

    const keptMass = kept.reduce((sum, i) => sum + probs[i], 0) || 1;
    return {
      kept,
      dropped: probs.map((_, i) => i).filter((i) => kept.indexOf(i) < 0),
      mass: keptMass,
    };
  }

  function sampleFrom(probs, kept, seed) {
    const mass = kept.reduce((sum, i) => sum + probs[i], 0) || 1;
    let u = hash01(seed) * mass;
    for (const i of kept) {
      u -= probs[i];
      if (u <= 0) return i;
    }
    return kept[kept.length - 1];
  }

  // ---------------------------------------------------------------- 格式化

  const pct = (v) => (v * 100).toFixed(1) + '%';
  const int = (v) => Math.round(v).toLocaleString('en-US');

  function fmtParams(count) {
    if (count >= 1e9) return (count / 1e9).toFixed(2) + 'B';
    return (count / 1e6).toFixed(0) + 'M';
  }

  function fmtGB(bytes) {
    const gb = bytes / 1024 / 1024 / 1024;
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    return (gb * 1024).toFixed(0) + ' MB';
  }

  // ------------------------------------------------------------ 绘制辅助

  // 指标卡 / 条形图 / 流程块 / 判断条都来自共享层，保证两个图解长得一样。
  // 下面几个薄包装只是为了让调用处读起来短一点，没有额外逻辑。
  const UI = window.GameWalk.ui;
  const note = UI.note;
  const bars = UI.bars;
  const flowRow = UI.flow;

  /**
   * 连续 stat() 调用要落在同一个网格里。第一次调用时在 host 下建一个 .wk-stats，
   * 之后的调用复用它——否则每张卡各包一个网格，宽屏上会竖着排成四行。
   */
  function stat(host, label, value, tone) {
    let grid = host.lastElementChild;
    if (!grid || !grid.classList.contains('wk-stats')) {
      grid = UI.stats(host, []);
    }
    return UI.statCard(grid, { label, value, tone });
  }

  function vecStrip(host, values, dim, scale) {
    const wrap = H('div', 'tf-vec');
    const limit = Math.max(scale, 0.001);
    values.slice(0, dim).forEach((v) => {
      const cell = H('i', v < 0 ? 'is-neg' : null, v.toFixed(1));
      const weight = Math.min(1, Math.abs(v) / limit);
      cell.style.background = v < 0
        ? 'rgba(214,69,69,' + (0.08 + weight * 0.3).toFixed(3) + ')'
        : 'rgba(59,91,253,' + (0.08 + weight * 0.3).toFixed(3) + ')';
      wrap.append(cell);
    });
    host.append(wrap);
    return wrap;
  }

  // ------------------------------------------------------------------ 步骤

  const steps = [
    // ---------------------------------------------------------------- 0
    {
      id: 'prompt',
      title: '提示词',
      short: '提示词',
      group: '输入',
      caption: '用户只给了一段文字。从下一条命令开始，模型再也不会看到「字」——它看到的全是整数。',
      draw(stage) {
        const bubble = H('div', 'tf-bubble');
        bubble.append(H('span', 'tf-bubble-role', '用户'), H('p', 'tf-bubble-text', PROMPT));
        stage.append(bubble);

        const stats = H('div', 'tf-stats');
        stat(stats, '字符数', String([...PROMPT].length));
        stat(stats, '按空格切开的词', String(PROMPT.split(/\s+/).length));
        stat(stats, 'BPE token 数', String(TOKENS.length), 'strong');
        stage.append(stats);

        note(stage,
          '三列数字的差距就是「为什么 token 数比字数重要」：计费按 token，' +
          '上下文窗口按 token，注意力的计算量也按 token。中文一个字常常就是一个 token，' +
          '而一个英文长词可能被切成三个。');
      },
    },

    // ---------------------------------------------------------------- 1
    {
      id: 'tokenize',
      title: '分词',
      short: '分词',
      group: '输入',
      caption: '把文字切成词表里的最小单位。切法决定了后面所有步骤的长度。',
      params: ['tokenizer'],
      draw(stage, api) {
        const mode = api.values.tokenizer;
        const tokens = mode === 'char'
          ? [...PROMPT].map((ch) => ({ text: ch, id: Math.floor(hash01(ch) * VOCAB) }))
          : TOKENS;

        const chips = H('div', 'tf-tokens');
        tokens.forEach((token) => {
          const chip = H('span', 'tf-token');
          chip.append(
            H('b', null, token.text === ' ' ? '␣' : token.text.trim() || '␣'),
            H('i', null, String(token.id))
          );
          chips.append(chip);
        });
        stage.append(chips);

        const n = tokens.length;
        const stats = H('div', 'tf-stats');
        stat(stats, '序列长度 n', String(n), 'strong');
        stat(stats, '注意力矩阵 n²', String(n * n));
        stat(stats, '相对 BPE 的计算量', (n * n / (TOKENS.length * TOKENS.length)).toFixed(1) + '×');
        stat(stats, '输入 KV 显存', fmtGB(n * kvPerToken(api.values.layers, 1)));
        stage.append(stats);

        note(stage,
          '把粒度从子词换成单字，序列长度变成 ' + n + '，注意力矩阵从 ' +
          TOKENS.length + '² = ' + (TOKENS.length * TOKENS.length) + ' 涨到 ' + n + '² = ' + (n * n) +
          '。长度只翻了 ' + (n / TOKENS.length).toFixed(1) + ' 倍，代价却翻了 ' +
          (n * n / (TOKENS.length * TOKENS.length)).toFixed(1) + ' 倍——这就是 O(n²) 的意思。');
      },
    },

    // ---------------------------------------------------------------- 2
    {
      id: 'embedding',
      title: '嵌入 + 位置编码',
      short: '嵌入',
      group: '输入',
      caption: '每个 token id 查表得到一个向量。但光有向量，模型分不清谁在前谁在后。',
      params: ['posEnc'],
      draw(stage, api) {
        const usePos = api.values.posEnc;
        const dim = 4;

        const a = ['猫', '追', '狗'];
        const b = ['狗', '追', '猫'];

        const grid = H('div', 'tf-pair');

        [
          { label: '句子 A「猫追狗」', words: a },
          { label: '句子 B「狗追猫」', words: b },
        ].forEach((sentence) => {
          const col = H('div', 'tf-pair-col');
          col.append(H('span', 'tf-pair-label', sentence.label));
          sentence.words.forEach((word, index) => {
            const row = H('div', 'tf-pair-row');
            row.append(H('span', 'tf-pair-word', word));

            const base = pseudoVec('word:' + word, dim, 2);
            if (usePos) {
              const pos = pseudoVec('pos:' + index, dim, 1.2);
              const sum = base.map((v, i) => Math.round((v + pos[i]) * 10) / 10);
              vecStrip(row, sum, dim, 4);
            } else {
              vecStrip(row, base, dim, 4);
            }
            col.append(row);
          });
          grid.append(col);
        });

        stage.append(grid);

        UI.verdict(stage, usePos
          ? '两个句子的向量集合不同 —— 位置一换，表示就变，模型能区分顺序。'
          : '两个句子的向量集合完全相同 —— 三个词还是那三个词，先后顺序彻底丢了。',
          usePos ? 'ok' : 'bad');

        note(stage,
          '严格说，自注意力对输入顺序是「等变」的：把输入重排，输出也会跟着重排，' +
          '但模型没有任何办法知道原来是什么顺序。所以位置信息必须由外部加进去——' +
          '这正是位置编码存在的唯一理由，而不是「让模型知道长度」。');
      },
    },

    // ---------------------------------------------------------------- 3
    {
      id: 'attention',
      title: '注意力',
      short: '注意力',
      group: '主干',
      caption: '每个 token 用自己的 Q 去问所有 token 的 K，按匹配度取走对应的 V。这是唯一让 token 之间交换信息的地方。',
      params: ['causal'],
      draw(stage, api) {
        const causal = api.values.causal;
        const n = TOKENS.length;

        const table = H('table', 'tf-matrix');
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        headRow.append(H('th', 'tf-matrix-corner', 'Q ↓ / K →'));
        TOKENS.forEach((token) => headRow.append(H('th', null, token.text.trim())));
        thead.append(headRow);
        table.append(thead);

        const tbody = document.createElement('tbody');
        for (let i = 0; i < n; i += 1) {
          const { weights, masked } = attentionRow(i, causal);
          const tr = document.createElement('tr');
          tr.append(H('th', null, TOKENS[i].text.trim()));
          for (let j = 0; j < n; j += 1) {
            const cell = H('td');
            if (masked.indexOf(j) >= 0) {
              cell.classList.add('is-masked');
              cell.textContent = '✕';
            } else {
              const w = weights[j];
              cell.style.background = 'rgba(15,118,110,' + (0.06 + w * 0.82).toFixed(3) + ')';
              cell.style.color = w > 0.45 ? '#ffffff' : '#14161b';
              cell.textContent = w >= 0.005 ? (w * 100).toFixed(0) : '·';
            }
            tr.append(cell);
          }
          tbody.append(tr);
        }
        table.append(tbody);
        stage.append(table);

        note(stage, causal
          ? '右上角全被 ✕ 挡住：生成第 i 个 token 时，它只能看自己和它前面的内容。' +
            '这不是为了省算力，是为了让训练目标和推理行为一致——否则模型会学会抄答案。'
          : '掩码关掉了，第一个 token 现在能直接看到「重要」。这就是「偷看未来」：' +
            '训练时这样会让模型学会抄下一个词，推理时又抄不到，表现会崩。');

        const stats = H('div', 'tf-stats');
        stat(stats, '序列长度 n', String(n));
        stat(stats, '这一层要算的格子数', String(n * n));
        stat(stats, '上下文翻倍后', '4× 计算量', 'warn');
        stage.append(stats);
      },
    },

    // ---------------------------------------------------------------- 4
    {
      id: 'norm',
      title: '归一化',
      short: '归一化',
      group: '主干',
      caption: '把每个 token 的向量拉回统一的尺度。它不改变方向，只改变长度。',
      params: ['normMode'],
      draw(stage, api) {
        const mode = api.values.normMode;
        const vec = [2.4, -1.8, 5.1, -3.3, 0.6, 7.2, -4.4, 1.1];
        const n = vec.length;
        const mean = vec.reduce((a, b) => a + b, 0) / n;
        const variance = vec.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
        const std = Math.sqrt(variance);
        const rms = Math.sqrt(vec.reduce((a, b) => a + b * b, 0) / n);

        const after = mode === 'layernorm'
          ? vec.map((v) => (v - mean) / std)
          : vec.map((v) => v / rms);

        UI.label(stage, '归一化前');
        vecStrip(stage, vec, n, 8);

        UI.label(stage, mode === 'layernorm'
          ? 'LayerNorm 之后（减均值、除标准差）'
          : 'RMSNorm 之后（只除均方根）');
        vecStrip(stage, after, n, 3);

        const stats = H('div', 'tf-stats');
        stat(stats, '原始均值', mean.toFixed(2));
        stat(stats, '原始标准差', std.toFixed(2));
        stat(stats, mode === 'layernorm' ? '处理后均值' : '处理后均值（未强制为 0）',
          (after.reduce((a, b) => a + b, 0) / n).toFixed(2), 'strong');
        stat(stats, '处理后标准差', Math.sqrt(
          after.reduce((a, b) => a + b * b, 0) / n - Math.pow(after.reduce((a, b) => a + b, 0) / n, 2)
        ).toFixed(2));
        stage.append(stats);

        note(stage, mode === 'layernorm'
          ? 'LayerNorm 减均值再除标准差，输出被强行归到均值 0、方差 1。'
          : 'RMSNorm 只除均方根，不减均值——省一次归约运算。现代大模型普遍用它，' +
            '因为在几百层的堆叠里，这一点点算术量会乘上几十次。');
      },
    },

    // ---------------------------------------------------------------- 5
    {
      id: 'ffn',
      title: '前馈网络',
      short: '前馈',
      group: '主干',
      caption: '每个 token 各自过一次两层的小网络：先升维，激活，再降回原维度。token 之间在这一步没有任何交流。',
      params: ['ffnRatio'],
      draw(stage, api) {
        const ratio = api.values.ffnRatio;
        const hidden = D_MODEL * ratio;

        flowRow(stage, [
          { title: '升维', sub: D_MODEL + ' → ' + int(hidden) },
          { title: '激活', sub: 'SwiGLU' },
          { title: '降维', sub: int(hidden) + ' → ' + D_MODEL },
        ]);

        const attnParams = 4 * D_MODEL * D_MODEL;
        const ffnParams = 2 * D_MODEL * hidden;
        const total = attnParams + ffnParams;

        const stats = H('div', 'tf-stats');
        stat(stats, '每层注意力参数', fmtParams(attnParams));
        stat(stats, '每层前馈参数', fmtParams(ffnParams), 'strong');
        stat(stats, '前馈占比', pct(ffnParams / total));
        stage.append(stats);

        bars(stage, [
          { label: '注意力（Q/K/V/O）', value: attnParams, text: fmtParams(attnParams) },
          { label: '前馈（升维 + 降维）', value: ffnParams, text: fmtParams(ffnParams), hit: true },
        ]);

        note(stage,
          '大多数人的直觉是「注意力是大头」，其实参数量上它一直比前馈小。' +
          '把倍数拖到 8，前馈会占到 ' + pct((2 * D_MODEL * D_MODEL * 8) / (attnParams + 2 * D_MODEL * D_MODEL * 8)) +
          '。这就是为什么推理时权重访存主要花在前馈上——decode 阶段慢，慢在这里。');
      },
    },

    // ---------------------------------------------------------------- 6
    {
      id: 'layers',
      title: '层堆叠',
      short: '层堆叠',
      group: '主干',
      caption: '上面三步整块重复 N 次。层数是「模型多大」最直观的那个数字，也是显存账本的主要项。',
      params: ['layers'],
      draw(stage, api) {
        const layers = api.values.layers;
        const perLayer = 4 * D_MODEL * D_MODEL + 2 * D_MODEL * D_MODEL * 4;
        const params = layers * perLayer + VOCAB * D_MODEL;
        const weights = params * BYTES_FP16;
        const kvPer = kvPerToken(layers, 1);

        flowRow(stage, [
          { title: '注意力', sub: '交换信息' },
          { title: '归一化', sub: '稳住尺度' },
          { title: '前馈', sub: '逐个变换' },
          { title: '× ' + layers + ' 层', sub: '整块重复', tone: 'accent' },
        ]);

        const stats = H('div', 'tf-stats');
        stat(stats, '总参数量', fmtParams(params), 'strong');
        stat(stats, '权重显存（fp16）', fmtGB(weights));
        stat(stats, '每 token 的 KV cache', fmtGB(kvPer));
        stat(stats, '每层参数', fmtParams(perLayer));
        stage.append(stats);

        note(stage,
          '把层数从 1 拖到 ' + layers + '，参数和显存一起线性上涨，但注意最后一列：' +
          'KV cache 也是随层数线性涨的。这就是「上下文一长就 OOM」的一半原因，' +
          '另一半在最后两步。');
      },
    },

    // ---------------------------------------------------------------- 7
    {
      id: 'logits',
      title: '输出头',
      short: '输出头',
      group: '输出',
      caption: '最后一层的那个向量，乘上词表矩阵，得到 12 万个分数。这些分数还不是概率。',
      params: [],
      draw(stage) {
        flowRow(stage, [
          { title: '最后位置向量', sub: D_MODEL + ' 维' },
          { title: '× 词表矩阵', sub: VOCAB.toLocaleString('en-US') + ' × ' + D_MODEL },
          { title: 'logits', sub: VOCAB.toLocaleString('en-US') + ' 个分数', tone: 'accent' },
        ]);

        const top = CANDIDATES;
        bars(stage, top.map((c) => ({
          label: c.text,
          value: c.logit,
          text: c.logit.toFixed(1),
        })));

        note(stage,
          'logits 可以是负数，加起来也不等于 1。它只表示「谁比谁更可能」。' +
          '要把这 12 万个分数变成真正能用来抽样的概率，还差一次 softmax——下一步就是它。');
      },
    },

    // ---------------------------------------------------------------- 8
    {
      id: 'sampling',
      title: '采样策略',
      short: '采样',
      group: '输出',
      caption: '温度、top-k、top-p 三个旋钮在这里起作用。它们不改变候选的顺序，只改变你实际会抽到谁。',
      params: ['strategy', 'temperature', 'topK', 'topP'],
      draw(stage, api) {
        const greedy = api.values.strategy === 'greedy';
        const temperature = api.values.temperature;
        const topK = api.values.topK;
        const topP = api.values.topP;

        const logits = CANDIDATES.map((c) => c.logit);
        const probs = softmaxAt(logits, greedy ? 0.01 : temperature);
        const { kept, dropped, mass } = greedy
          ? { kept: [0], dropped: probs.map((_, i) => i).slice(1), mass: 1 }
          : truncate(probs, topK, topP);

        const seed = 'sample:' + temperature + ':' + topK + ':' + topP + ':' + api.values.strategy;
        const chosen = greedy ? 0 : sampleFrom(probs, kept, seed);

        const items = CANDIDATES.map((c, i) => ({
          label: c.text,
          value: probs[i],
          text: pct(probs[i]),
          dim: kept.indexOf(i) < 0,
          hit: i === chosen,
        }));
        bars(stage, items);

        const stats = H('div', 'tf-stats');
        stat(stats, '保留候选', kept.length + ' / ' + CANDIDATES.length, 'strong');
        stat(stats, '保留的累计概率', pct(mass));
        stat(stats, '本次生成', '#' + (chosen + 1) + '「' + CANDIDATES[chosen].text + '」', 'strong');
        stat(stats, '被丢掉的候选', dropped.length ? '共 ' + dropped.length + ' 个' : '无');
        stage.append(stats);

        UI.verdict(stage, greedy
          ? '贪心策略：永远取分数最高的那个。温度在这里完全不起作用——不管拖到哪，结果都一样。'
          : '温度 ' + temperature.toFixed(1) + ' 把概率重新分配了一遍，但候选的先后顺序一个都没变。',
          'ok');

        note(stage,
          '三个旋钮干的是三件不同的事：温度「重塑」整个分布（差距变大或变小），' +
          'top-k「砍掉」排名之后的候选，top-p 按「累计概率」砍——' +
          '所以 top-p 保留的数量会随分布变化，top-k 是固定的。' +
          '注意看：把温度拖到 0，被丢掉的候选概率趋近于 0，但第一名始终是第一名。');
      },
    },

    // ---------------------------------------------------------------- 9
    {
      id: 'prefill',
      title: 'Prefill 与 Decode',
      short: 'prefill/decode',
      group: '解码',
      caption: '提示词进来时是一次并行前向（prefill）；之后每吐一个字都要一次完整前向（decode）。两个阶段的瓶颈完全不同。',
      params: ['outputLen'],
      draw(stage, api) {
        const outputLen = api.values.outputLen;
        const promptLen = TOKENS.length;

        const timeline = H('div', 'tf-timeline');
        const prefillBlock = H('div', 'tf-tl-block is-prefill');
        prefillBlock.append(H('b', null, 'prefill'), H('span', null, promptLen + ' 个 token 一次算完'));
        prefillBlock.style.flex = '0 0 ' + Math.max(30, promptLen * 8) + 'px';
        timeline.append(prefillBlock);
        for (let i = 0; i < Math.min(outputLen, 32); i += 1) {
          timeline.append(H('i', 'tf-tl-tick'));
        }
        if (outputLen > 32) timeline.append(H('span', 'tf-tl-more', '…'));
        stage.append(timeline);

        const forwards = 1 + outputLen;
        const withCache = promptLen + outputLen;
        const withoutCache = promptLen + outputLen * promptLen + (outputLen * (outputLen + 1)) / 2;

        const stats = H('div', 'tf-stats');
        stat(stats, '前向次数', String(forwards), 'strong');
        stat(stats, '有 KV cache 的处理量', int(withCache) + ' token');
        stat(stats, '无 KV cache 的处理量', int(withoutCache) + ' token', 'warn');
        stat(stats, '倍数', (withoutCache / withCache).toFixed(1) + '×');
        stage.append(stats);

        note(stage,
          'prefill 是算力密集：一次吃下整段提示词，GPU 的矩阵乘能跑满，' +
          '所以几千个 token 往往只要几百毫秒。decode 是访存密集：' +
          '一次只有一个 token，却要把整个模型的权重从显存搬到计算单元，' +
          'GPU 大部分时间在等数据。这也是为什么「首字延迟」和「每秒字数」是两个完全不同的指标。');
      },
    },

    // ---------------------------------------------------------------- 10
    {
      id: 'kv-cache',
      title: 'KV 缓存',
      short: 'KV cache',
      group: '解码',
      caption: 'decode 之所以不用重算前面所有 token，全靠把每层的 K 和 V 存下来。省下的计算量，用显存换。',
      params: ['ctxLen', 'kvShare'],
      draw(stage, api) {
        const ctxLen = api.values.ctxLen;
        const layers = api.values.layers;
        const share = Number(api.values.kvShare);

        const perToken = kvPerToken(layers, share);
        const total = perToken * ctxLen;
        const weights = (layers * (4 * D_MODEL * D_MODEL + 2 * D_MODEL * D_MODEL * 4)
          + VOCAB * D_MODEL) * BYTES_FP16;

        const stats = H('div', 'tf-stats');
        stat(stats, '上下文长度', int(ctxLen) + ' token');
        stat(stats, '每 token 的 KV', fmtGB(perToken), 'strong');
        stat(stats, 'KV 总量', fmtGB(total), 'warn');
        stat(stats, '模型权重占用', fmtGB(weights));
        stage.append(stats);

        bars(stage, [
          { label: '模型权重', value: weights, text: fmtGB(weights) },
          { label: 'KV cache（当前上下文）', value: total, text: fmtGB(total), hit: true },
        ]);

        note(stage,
          '把上下文拖到 128k，看这一行会变成多少——它会超过权重本身。' +
          '这就是长上下文真正贵的地方：不是算不动，是显存装不下。' +
          '右侧参数里的 GQA / MQA 是工程上的解法：让多个注意力头共享同一份 K/V，' +
          '把这一项直接除以 4 或除以 8，代价是模型能力略降。');
      },
    },

    // ---------------------------------------------------------------- 11
    {
      id: 'speculative',
      title: '投机解码',
      short: '投机解码',
      group: '解码',
      caption: 'decode 阶段的 GPU 在等数据，那就让它一次多验几个位置。用便宜的小模型先猜，大模型一次并行验收。',
      params: ['specK', 'acceptRate'],
      draw(stage, api) {
        const accept = api.values.acceptRate;
        const chosenK = api.values.specK;

        const rows = [];
        for (let k = 1; k <= 8; k += 1) {
          const advance = expectedAdvance(k, accept);
          const time = 1 + 0.05 * k + 0.004 * k * k;
          rows.push({
            k,
            speedup: advance / time,
          });
        }
        const best = rows.reduce((a, b) => (b.speedup > a.speedup ? b : a));

        const mine = rows[chosenK - 1];
        bars(stage, rows.map((row) => ({
          label: 'k=' + row.k,
          value: row.speedup,
          text: row.speedup.toFixed(2) + '×',
          hit: row.k === chosenK,
        })));

        const stats = H('div', 'tf-stats');
        stat(stats, '每轮期望推进', expectedAdvance(chosenK, accept).toFixed(2) + ' token');
        stat(stats, '每轮耗时', (1 + 0.05 * chosenK + 0.004 * chosenK * chosenK).toFixed(2) + ' 单位');
        stat(stats, '你的加速比', mine.speedup.toFixed(2) + '×', 'strong');
        stat(stats, '该接受率下的最优 k', 'k=' + best.k);
        stage.append(stats);

        note(stage,
          '和「投机采样」那个游戏用的是同一个时间模型：每轮耗时 1 + 0.05k + 0.004k²。' +
          '接受率越高，最优 k 越大；把接受率拖到 0.5 以下，你会发现 k=1 反而最好——' +
          '因为多猜出来的位置几乎全被拒，纯属白花时间。');
      },
    },
  ];

  // -------------------------------------------------------------- 派生计算

  /**
   * 每 token 的 KV 占用。系数 2 是 K 和 V 各一份；
   * share 是 GQA / MQA 的共享比例（1 = 标准多头，0.25 = 四头共享，0.125 = 全部共享）。
   */
  function kvPerToken(layers, share) {
    return 2 * layers * D_MODEL * BYTES_FP16 * (share || 1);
  }

  /** 投机解码每轮的期望推进量：至少 1 个（target 自己补的那个），加上被接受的猜测。 */
  function expectedAdvance(k, accept) {
    if (accept >= 0.999) return k + 1;
    return (1 - Math.pow(accept, k + 1)) / (1 - accept);
  }

  // ---------------------------------------------------------------- 挂载

  window.GameWalk.mount({
    id: 'transformer',
    title: 'Transformer 全流程',
    kicker: '图解',
    lede: '从一段文字到一个字，中间有 12 道工序。每一步都能拧参数——拧坏了不要紧，翻回去就行。',
    loop: false,
    params: [
      {
        id: 'tokenizer',
        label: '分词粒度',
        type: 'select',
        value: 'bpe',
        options: [
          { value: 'bpe', label: '子词（BPE）' },
          { value: 'char', label: '单字' },
        ],
      },
      { id: 'posEnc', label: '位置编码', type: 'toggle', value: true },
      { id: 'causal', label: '因果掩码', type: 'toggle', value: true },
      {
        id: 'normMode',
        label: '归一化方式',
        type: 'select',
        value: 'rmsnorm',
        options: [
          { value: 'rmsnorm', label: 'RMSNorm' },
          { value: 'layernorm', label: 'LayerNorm' },
        ],
      },
      {
        id: 'ffnRatio',
        label: '前馈倍数',
        type: 'range',
        min: 2,
        max: 8,
        step: 1,
        value: 4,
        format: (v) => v + '×',
      },
      {
        id: 'layers',
        label: '层数',
        type: 'range',
        min: 1,
        max: 48,
        step: 1,
        value: 32,
        format: (v) => v + ' 层',
      },
      {
        id: 'strategy',
        label: '策略',
        type: 'select',
        value: 'sample',
        options: [
          { value: 'sample', label: '按概率采样' },
          { value: 'greedy', label: '贪心' },
        ],
      },
      {
        id: 'temperature',
        label: '温度 T',
        type: 'range',
        min: 0,
        max: 2,
        step: 0.1,
        value: 0.9,
        format: (v) => Number(v).toFixed(1),
      },
      {
        id: 'topK',
        label: 'top-k',
        type: 'range',
        min: 1,
        max: 8,
        step: 1,
        value: 8,
        format: (v) => '保留 ' + v,
      },
      {
        id: 'topP',
        label: 'top-p',
        type: 'range',
        min: 0.1,
        max: 1,
        step: 0.05,
        value: 0.95,
        format: (v) => Number(v).toFixed(2),
      },
      {
        id: 'outputLen',
        label: '输出长度',
        type: 'range',
        min: 1,
        max: 64,
        step: 1,
        value: 32,
        format: (v) => v + ' token',
      },
      {
        id: 'ctxLen',
        label: '上下文',
        type: 'range',
        min: 1024,
        max: 131072,
        step: 1024,
        value: 32768,
        format: (v) => (v / 1024).toFixed(0) + 'k',
      },
      {
        id: 'kvShare',
        label: 'KV 共享',
        type: 'select',
        value: '1',
        options: [
          { value: '1', label: 'MHA（不共享）' },
          { value: '0.25', label: 'GQA（4 头共享）' },
          { value: '0.125', label: 'MQA（全部共享）' },
        ],
      },
      {
        id: 'specK',
        label: '每轮猜 k 个',
        type: 'range',
        min: 1,
        max: 8,
        step: 1,
        value: 4,
        format: (v) => 'k=' + v,
      },
      {
        id: 'acceptRate',
        label: '接受率',
        type: 'range',
        min: 0.3,
        max: 0.99,
        step: 0.01,
        value: 0.8,
        format: (v) => (Number(v) * 100).toFixed(0) + '%',
      },
    ],
    steps,
  });
})();
