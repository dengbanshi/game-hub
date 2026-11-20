/* ==========================================================================
   context-window/scenario.js —— 纯数据
   --------------------------------------------------------------------------
   按 doc/ARCHITECTURE.md §4.2 的约定：这个文件只有数据，没有 DOM 操作、没有副作用。
   想换个场景（比如做一次线上故障复盘、或者换成客服工单），只改这个文件，逻辑不用动。

   字段说明：
     value   key    = 定位根因必须留下的证据
             weak   = 有点用，但缺了也能推理
             noise  = 与任务无关（有的占位还特别大，这就是陷阱）
     size    原文占用的上下文格数
     needs   问题成立所需的最低证据：level = 'full' 表示必须保留原文
             （压缩后只留下「有这么件事」，数字和细节都没了）
   ========================================================================== */

const SCENARIO = {
  title: 'P99 从 120ms 涨到 900ms',

  brief:
    '你是今天的值班工程师。14:00 收到一条支付接口延迟告警，需要在 20 分钟内给出根因。' +
    '上下文预算只有 24 格，信息会陆续进来，你必须决定哪些留原话、哪些压成摘要、哪些直接扔掉。',

  budget: 24,

  rounds: [
    {
      id: 1,
      time: '14:02',
      label: '第一条告警',
      items: [
        {
          id: 'a1',
          from: '告警',
          title: 'pay-api P99 延迟 900ms',
          detail: 'pay-api 的 P99 从 120ms 涨到 900ms，超过 300ms 阈值，已持续 6 分钟。',
          size: 2,
          value: 'key',
        },
        {
          id: 'a2',
          from: '值班',
          title: '已确认非误报',
          detail: '14:02 值班同学确认告警真实存在，开始排查。',
          size: 1,
          value: 'weak',
        },
        {
          id: 'a3',
          from: '群聊',
          title: '午饭投票',
          detail: '12 条关于午饭的聊天记录，含 3 张图片和 2 个投票，讨论了 8 分钟。',
          size: 8,
          value: 'noise',
        },
      ],
    },
    {
      id: 2,
      time: '14:06',
      label: '变更与指标',
      items: [
        {
          id: 'b1',
          from: '变更',
          title: '14:00 发布 v2.31.0',
          detail: '变更单 CHG-8821：14:00 发布 v2.31.0，新增优惠券校验，涉及 pay-api 与 coupon-svc，灰度 100%。',
          size: 3,
          value: 'key',
        },
        {
          id: 'b2',
          from: '指标',
          title: 'QPS 持平，GC 时间上升',
          detail: 'pay-api QPS 4200，与上周同期持平；CPU 38%；GC 时间同比 +240%。',
          size: 2,
          value: 'key',
        },
        {
          id: 'b3',
          from: '群聊',
          title: '「大概是网络抖动吧」',
          detail: '同事在群里说：大概是网络抖动吧，重启一下试试。',
          size: 1,
          value: 'noise',
        },
      ],
    },
    {
      id: 3,
      time: '14:12',
      label: '下游开始说话',
      items: [
        {
          id: 'c1',
          from: '监控',
          title: 'coupon-svc 调用耗时 620ms',
          detail: 'pay-api → coupon-svc 的 query 调用耗时 620ms，超时率 12%，调用量 4200 QPS。',
          size: 2,
          value: 'key',
        },
        {
          id: 'c2',
          from: '日志',
          title: '超时 32417 次',
          detail: 'CouponService.query timeout after 500ms —— 14:05 至 14:12 共出现 32,417 次。',
          size: 6,
          value: 'key',
        },
        {
          id: 'c3',
          from: '邮件',
          title: '财务询问云账单',
          detail: '财务发邮件询问本月云账单为什么涨了 18%。',
          size: 2,
          value: 'noise',
        },
      ],
    },
    {
      id: 4,
      time: '14:18',
      label: '处置结果',
      items: [
        {
          id: 'd1',
          from: '群聊',
          title: '已回滚，延迟恢复',
          detail: '14:18 回滚 v2.31.0，P99 恢复到 130ms。',
          size: 2,
          value: 'key',
        },
        {
          id: 'd2',
          from: '群聊',
          title: '周末团建',
          detail: '讨论周末团建去哪，附了 5 张烧烤照片和一段 40 秒的视频。',
          size: 4,
          value: 'noise',
        },
      ],
    },
  ],

  questions: [
    {
      id: 'q1',
      afterRound: 2,
      text: '14:00 那次发布，v2.31.0 具体改了什么？',
      options: [
        '新增了优惠券校验，涉及 pay-api 与 coupon-svc',
        '把接口限流阈值从 500 调到 300',
        '升级了数据库驱动版本',
      ],
      answer: 0,
      needs: [{ item: 'b1', level: 'full' }],
      explainRight: '变更单写得很清楚：新增优惠券校验，涉及 pay-api 与 coupon-svc。这一条把「发布」和「下游」连了起来。',
      explainWrong: '限流和驱动都没有出现在这次变更单里。真实排障里，凭印象补全变更是最常见的错误来源。',
    },
    {
      id: 'q2',
      afterRound: 4,
      text: '根因是什么？',
      options: [
        '新增的优惠券校验同步调用 coupon-svc，下游处理不过来导致超时',
        '网络抖动',
        '流量突增超出容量',
      ],
      answer: 0,
      needs: [
        { item: 'b1', level: 'any' },
        { item: 'c1', level: 'any' },
      ],
      explainRight:
        '证据链是：14:00 发布新增优惠券校验 → coupon-svc 调用耗时 620ms、超时率 12% → 回滚后延迟恢复。' +
        '三个环节都对上，才能叫根因。',
      explainWrong:
        'QPS 与上周持平，流量突增不成立；网络抖动没有任何指标支持，只是群里的一句猜测。' +
        '排障时最贵的错误，就是把别人的猜测当成了证据。',
    },
    {
      id: 'q3',
      afterRound: 4,
      text: 'coupon 调用的超时阈值设成了多少？',
      options: ['500ms', '1000ms', '300ms'],
      answer: 0,
      needs: [{ item: 'c2', level: 'full' }],
      explainRight: '日志原文是 "timeout after 500ms"，而实际调用耗时 620ms —— 每次都必然超时。',
      explainWrong: '300ms 是告警阈值，不是 RPC 超时阈值。这两个数字很容易混，混了就会得出错误的容量结论。',
    },
  ],
};
