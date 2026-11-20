const $ = (id) => document.getElementById(id);

const lobby = $('lobby');
const tabsEl = $('tabs');
const gridEl = $('games');
const statusEl = $('status');
const emptyEl = $('empty');
const searchEl = $('search');
const player = $('player');
const frame = $('frame');
const titleEl = $('title');
const newtab = $('newtab');
const doclink = $('doclink');

const PALETTE = ['#3b5bfd', '#0f766e', '#b45309', '#7c3aed', '#be123c', '#0369a1'];
const ALL = { id: 'all', name: '全部' };

let games = [];
let categories = [];
let active = 'all';
let repo = '';

/** 目录前缀、卡片徽标、计数都要用到，抽出来避免三处各判一次。 */
const KIND_DIR = { game: 'games', walk: 'walks' };
const KIND_LABEL = { game: '游戏', walk: '图解' };

function kindOf(entry) {
  return entry && entry.kind === 'walk' ? 'walk' : 'game';
}

// 游戏内的帮助弹层是覆盖层，用户按 Esc 的本意多半是「关掉弹层」。
// 游戏会通过 postMessage 告知覆盖层状态，这里据此让 Esc 只做一件事。
let overlayOpen = false;

function colorOf(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function countOf(categoryId) {
  if (categoryId === 'all') return games.length;
  return games.filter((g) => g.category === categoryId).length;
}

/** 状态栏用：这一分类下分别是几个游戏、几个图解。 */
function kindBreakdown(categoryId) {
  const list = categoryId === 'all'
    ? games
    : games.filter((g) => g.category === categoryId);
  const walk = list.filter((g) => kindOf(g) === 'walk').length;
  return { walk, game: list.length - walk };
}

function categoryName(categoryId) {
  const found = categories.find((c) => c.id === categoryId);
  return found ? found.name : categoryId;
}

function makeCard(g) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  btn.setAttribute('aria-label', '打开 ' + g.name);

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = [...g.name][0] || '?';
  avatar.style.color = colorOf(g.id);
  avatar.style.background = colorOf(g.id) + '1f';

  const name = document.createElement('strong');
  name.textContent = g.name;

  const kind = kindOf(g);
  const badge = document.createElement('span');
  badge.className = 'kind is-' + kind;
  badge.textContent = KIND_LABEL[kind];

  const titleLine = document.createElement('span');
  titleLine.className = 'title-line';
  titleLine.append(name, badge);

  const meta = document.createElement('span');
  meta.className = 'meta';
  const tag = g.category ? categoryName(g.category) : '';
  meta.textContent = (tag ? tag + ' · ' : '') + `v${g.version} · 资源 #${g.contentCode}`;

  btn.append(avatar, titleLine, meta);
  btn.addEventListener('click', () => openGame(g));
  return btn;
}

function renderTabs() {
  const list = [ALL, ...categories];
  tabsEl.replaceChildren(
    ...list.map((cat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab' + (cat.id === active ? ' is-active' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(cat.id === active));
      btn.dataset.id = cat.id;

      const label = document.createElement('span');
      label.textContent = cat.name;
      const count = document.createElement('span');
      count.className = 'n';
      count.textContent = String(countOf(cat.id));

      btn.append(label, count);
      btn.addEventListener('click', () => select(cat.id));
      return btn;
    })
  );
}

function select(categoryId) {
  const known = [ALL, ...categories].some((c) => c.id === categoryId);
  if (!known) return;

  active = categoryId;

  const nextHash = categoryId === 'all' ? '' : '#' + categoryId;
  const currentHash = location.hash;
  if (currentHash !== nextHash) {
    history.replaceState(null, '', nextHash || location.pathname + location.search);
  }

  renderTabs();
  render();
}

function render() {
  const q = searchEl.value.trim().toLocaleLowerCase();
  const list = games.filter(
    (g) =>
      (active === 'all' || g.category === active) &&
      (g.name.toLocaleLowerCase().includes(q) || g.id.includes(q))
  );

  gridEl.replaceChildren(...list.map(makeCard));

  const total = countOf(active);
  emptyEl.hidden = list.length > 0;
  if (!list.length) {
    if (!games.length) emptyEl.textContent = '清单是空的。';
    else if (q) emptyEl.textContent = '没有找到匹配的条目。';
    else emptyEl.textContent = `${categoryName(active)} 分类里还没有内容，正在做。`;
  }

  const parts = kindBreakdown(active);
  const detail = total === 0
    ? ''
    : `（${parts.game} 游戏 · ${parts.walk} 图解）`;

  statusEl.textContent = q && list.length !== total
    ? `${list.length} / ${total} 个条目`
    : `${total} 个条目${detail}`;
}

function openGame(g) {
  const dir = KIND_DIR[kindOf(g)];
  const url = new URL(`./${dir}/${g.id}/${g.entry}`, location.href);
  frame.src = url.href;
  newtab.href = url.href;
  titleEl.textContent = g.name;

  // 设计文档放在仓库里，所以必须跳到 GitHub 才能渲染 Markdown。
  // repo 写在 games.json 顶层，fork 之后改一处即可。
  const docUrl = repo && g.doc ? `https://github.com/${repo}/blob/main/${g.doc}` : '';
  doclink.hidden = !docUrl;
  doclink.href = docUrl || '#';

  overlayOpen = false;
  lobby.hidden = true;
  player.hidden = false;
  document.title = g.name + ' · 游戏大厅';
  frame.focus();
}

function closeGame() {
  frame.src = 'about:blank';
  player.hidden = true;
  lobby.hidden = false;
  overlayOpen = false;
  doclink.hidden = true;
  document.title = '游戏大厅';
  searchEl.focus();
}

$('back').addEventListener('click', closeGame);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !player.hidden && !overlayOpen) closeGame();
});

window.addEventListener('message', (event) => {
  // 只接受当前 iframe 自己发来的消息，避免同源的其他窗口误触发。
  if (event.origin !== location.origin) return;
  if (event.source !== frame.contentWindow) return;
  if (!event.data) return;

  // 内容页把 Esc 转发上来：弹层没开时，Esc 的含义是「退出当前内容」。
  // 必须在内容页侧转发——大厅打开内容后焦点在 iframe 里，拿不到这个按键。
  if (event.data.type === 'game-hub:escape') {
    if (!overlayOpen) closeGame();
    return;
  }

  if (event.data.type !== 'game-hub:overlay') return;
  overlayOpen = Boolean(event.data.open);
});

searchEl.addEventListener('input', render);

window.addEventListener('hashchange', () => {
  const id = location.hash.replace('#', '') || 'all';
  if (id !== active && [ALL, ...categories].some((c) => c.id === id)) {
    active = id;
    renderTabs();
    render();
  }
});

async function boot() {
  try {
    const res = await fetch('./games.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    games = Array.isArray(data.games) ? data.games : [];
    categories = Array.isArray(data.categories) ? data.categories : [];
    repo = typeof data.repo === 'string' ? data.repo : '';

    const declared = new Set(categories.map((c) => c.id));
    for (const g of games) {
      if (g.category && !declared.has(g.category)) {
        declared.add(g.category);
        categories.push({ id: g.category, name: g.category });
      }
    }

    if (!games.length) throw new Error('清单里没有游戏');

    const fromHash = location.hash.replace('#', '');
    if (fromHash && [ALL, ...categories].some((c) => c.id === fromHash)) active = fromHash;

    renderTabs();
    render();
  } catch (error) {
    statusEl.textContent = '读取清单失败：' + error.message;
    emptyEl.hidden = false;
    emptyEl.textContent =
      '读不到 ./games.json。如果你是双击用 file:// 打开的，浏览器会拒绝本地 fetch，' +
      '请改用本地 http 服务器（例如 python -m http.server 8000）。';
  }
}

boot();
