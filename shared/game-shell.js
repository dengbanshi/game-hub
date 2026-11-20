/* ==========================================================================
   game-shell.js —— 所有游戏共用的外壳逻辑
   --------------------------------------------------------------------------
   它只做四件事，多一件都不要往里塞（见 doc/ARCHITECTURE.md「共享层的边界」）：
     1. 把统一顶栏注入 #gh-bar：返回大厅（仅独立打开时）、帮助按钮
     2. 把 #gh-help-source 里的内容渲染成一个帮助弹层
     3. 提供带命名空间的 localStorage 封装，避免各游戏键名互相覆盖
     4. 在 iframe 内把「弹层已打开」告诉大厅，让大厅的 Esc 不要顺手关掉游戏

   游戏页不需要调用任何初始化函数：脚本加载时自动挂载。
   这样「忘记调用」这种低级错误在结构上就不存在了。
   ========================================================================== */

(function () {
  'use strict';

  const HELP_SOURCE_ID = 'gh-help-source';
  const BAR_ID = 'gh-bar';
  const OVERLAY_MESSAGE = 'game-hub:overlay';
  const ESCAPE_MESSAGE = 'game-hub:escape';

  const shell = {
    title: '',
    modal: null,
    helpBody: null,
    lastFocus: null,
    helpButton: null,
    // 页面自己要用 Esc 时，在 #gh-bar 上写 data-esc="local" 把它留下来
    escapeLocal: false,
  };

  /** 处于 iframe 中时，返回大厅由大厅顶栏负责，游戏内不应重复提供入口。 */
  function inIframe() {
    try {
      return window.self !== window.top;
    } catch (error) {
      // 跨域父窗口访问 window.top 会抛错，那就按「在 iframe 里」处理，宁可少显示一个链接。
      return true;
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * 读取游戏页写在 #gh-help-source 里的帮助内容。
   * 用 innerHTML 而不是解析成数据结构：帮助内容是给人读的排版文本，
   * 强行抽象成 JSON 只会让贡献者多写一层没人看的转义。
   */
  function readHelpSource() {
    const source = document.getElementById(HELP_SOURCE_ID);
    if (!source) {
      console.warn(
        '[game-shell] 页面缺少 #gh-help-source，帮助弹层没有内容可显示。' +
        '这是开发规范里的硬要求，见 doc/DEV-GUIDE.md。'
      );
      return '<p>这个游戏还没有写帮助内容。</p>';
    }
    return source.innerHTML;
  }

  function buildModal() {
    if (shell.modal) return shell.modal;

    const modal = el('div', 'gh-modal');
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'gh-help-title');

    const panel = el('div', 'gh-panel');

    const close = el('button', 'gh-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭帮助');

    const kicker = el('div', 'gh-kicker', '玩法与原理');
    const heading = el('h2', null, shell.title || document.title);
    heading.id = 'gh-help-title';

    const body = el('div', 'gh-help');
    body.innerHTML = readHelpSource();

    panel.append(close, kicker, heading, body);
    modal.append(panel);
    document.body.append(modal);

    close.addEventListener('click', closeHelp);

    // 点遮罩关闭，点面板内部不关。用 target === modal 判断，
    // 比给 panel 加 stopPropagation 更不容易随内部结构变化而失效。
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeHelp();
    });

    shell.modal = modal;
    shell.helpBody = body;
    return modal;
  }

  /**
   * 把 Esc 转发给大厅，让大厅关闭当前内容。
   *
   * 为什么必须显式转发：大厅打开内容时会 focus iframe，此后焦点在 iframe 内部，
   * 按键事件只在这一层 document 上冒泡，永远到不了父窗口的 document。
   * 也就是说「再按一次 Esc 返回大厅」这句写在文档里的行为，不做转发是根本不成立的
   * ——第一版就是这样，Esc 在内容页里完全没反应。
   */
  function notifyParentEscape() {
    if (!inIframe()) return;
    try {
      window.parent.postMessage({ type: ESCAPE_MESSAGE }, window.location.origin);
    } catch (error) {
      // 父窗口不可达就算了，用户还能点「← 返回大厅」。
    }
  }

  /** 通知父窗口（大厅）当前是否有覆盖层，避免 Esc 被两边同时响应。 */
  function notifyParent(isOpen) {
    if (!inIframe()) return;
    try {
      window.parent.postMessage(
        { type: OVERLAY_MESSAGE, open: isOpen },
        window.location.origin
      );
    } catch (error) {
      // 父窗口不可达就算了，Esc 顶多多关一次游戏，不该因此中断帮助功能。
    }
  }

  function openHelp() {
    const modal = buildModal();
    if (!modal.hidden) return;

    shell.lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    notifyParent(true);

    const close = modal.querySelector('.gh-close');
    if (close) close.focus();
  }

  function closeHelp() {
    if (!shell.modal || shell.modal.hidden) return;

    shell.modal.hidden = true;
    document.body.style.overflow = '';
    notifyParent(false);

    if (shell.lastFocus && typeof shell.lastFocus.focus === 'function') {
      shell.lastFocus.focus();
    } else if (shell.helpButton) {
      shell.helpButton.focus();
    }
    shell.lastFocus = null;
  }

  /**
   * 供游戏查询：帮助弹层是否打开。
   * 键盘驱动的游戏必须在 keydown 开头调用它并直接 return，
   * 否则读者在弹层里按空格滚动，游戏会同时暂停；按方向键，方块会跟着动。
   * 这里不能替游戏 stopPropagation——那样弹层内的按钮也收不到 Enter/Space。
   */
  function isHelpOpen() {
    return Boolean(shell.modal && !shell.modal.hidden);
  }

  /**
   * 键盘处理挂在捕获阶段：弹层打开时必须先吃掉 Esc 和 Tab，
   * 否则游戏自己的快捷键会穿透进来（例如贪吃蛇用 Esc 暂停），
   * 用户按一下 Esc 想关帮助，结果同时把游戏也暂停了。
   */
  function onKeydown(event) {
    if (!shell.modal || shell.modal.hidden) {
      // 弹层没开：Esc 的意思就是「退出当前内容」，转发给大厅。
      if (event.key === 'Escape' && !shell.escapeLocal) notifyParentEscape();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeHelp();
      return;
    }

    if (event.key !== 'Tab') return;

    // 极简焦点循环：弹层里能聚焦的元素本来就只有关闭按钮和正文里的链接。
    const focusables = shell.modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function mountBar() {    let bar = document.getElementById(BAR_ID);

    // 兜底：页面忘了写 #gh-bar 也照样给一个帮助入口。
    // 规范要求「每个游戏都有帮助按钮」，那就不能让漏写变成功能缺失。
    if (!bar) {
      console.warn('[game-shell] 页面缺少 <header id="gh-bar">，已自动补在 body 开头。');
      bar = el('header');
      bar.id = BAR_ID;
      document.body.insertBefore(bar, document.body.firstChild);
    }

    if (bar.dataset.ghReady === '1') return;

    shell.title = bar.dataset.title || document.title;
    shell.escapeLocal = bar.dataset.esc === 'local';

    const back = el('a', 'gh-link', '← 返回大厅');
    back.href = '../../index.html';
    back.hidden = inIframe();

    const help = el('button', 'gh-btn', '? 玩法与原理');
    help.type = 'button';
    help.setAttribute('aria-haspopup', 'dialog');
    help.addEventListener('click', openHelp);

    bar.append(back, el('span', 'gh-spacer'), help);
    bar.dataset.ghReady = '1';
    shell.helpButton = help;

    document.addEventListener('keydown', onKeydown, true);
  }

  /**
   * 带命名空间的存档。前缀固定为 game-hub:<namespace>:，
   * 所有游戏同源共用 localStorage，不隔离就一定会撞车。
   * 全部读写包 try/catch：隐私模式或配额满时 localStorage 会抛错，
   * 存档失败不应该让游戏直接白屏。
   */
  function store(namespace) {
    const prefix = 'game-hub:' + namespace + ':';
    return {
      get(key, fallback) {
        try {
          const raw = localStorage.getItem(prefix + key);
          return raw === null ? fallback : JSON.parse(raw);
        } catch (error) {
          return fallback;
        }
      },
      set(key, value) {
        try {
          localStorage.setItem(prefix + key, JSON.stringify(value));
        } catch (error) {
          /* 存不上就算了，不影响本局 */
        }
      },
      remove(key) {
        try {
          localStorage.removeItem(prefix + key);
        } catch (error) {
          /* 同上 */
        }
      },
    };
  }

  function boot() {
    mountBar();
    buildModal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.GameShell = {
    inIframe,
    isHelpOpen,
    /** 页面想自己处理 Esc 时调它，之后 Esc 不再转发给大厅。 */
    reserveEscape() {
      shell.escapeLocal = true;
    },
    openHelp,
    closeHelp,
    store,
    get title() {
      return shell.title;
    },
  };
})();
