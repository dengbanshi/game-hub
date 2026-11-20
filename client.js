const $ = (id) => document.getElementById(id);

const lobby = $('lobby');
const gridEl = $('games');
const statusEl = $('status');
const emptyEl = $('empty');
const searchEl = $('search');
const player = $('player');
const frame = $('frame');
const titleEl = $('title');
const newtab = $('newtab');

const PALETTE = ['#3b5bfd', '#0f766e', '#b45309', '#7c3aed', '#be123c', '#0369a1'];

let games = [];

function colorOf(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function makeCard(g) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  btn.setAttribute('aria-label', '打开 ' + g.name);
  btn.style.setProperty('--card-accent', colorOf(g.id));

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = [...g.name][0] || '?';
  avatar.style.color = colorOf(g.id);
  avatar.style.background = colorOf(g.id) + '1f';

  const name = document.createElement('strong');
  name.textContent = g.name;

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `v${g.version} · 资源 #${g.contentCode}`;

  btn.append(avatar, name, meta);
  btn.addEventListener('click', () => openGame(g));
  return btn;
}

function render() {
  const q = searchEl.value.trim().toLocaleLowerCase();
  const list = games.filter((g) =>
    g.name.toLocaleLowerCase().includes(q) || g.id.includes(q)
  );
  gridEl.replaceChildren(...list.map(makeCard));
  emptyEl.hidden = list.length > 0;
  if (list.length === 0 && games.length > 0) {
    emptyEl.textContent = '没有找到匹配的游戏。';
  }
  statusEl.textContent = games.length
    ? q ? `${list.length} / ${games.length} 个游戏` : `${games.length} 个游戏`
    : statusEl.textContent;
}

function openGame(g) {
  const url = new URL(`./games/${g.id}/${g.entry}`, location.href);
  frame.src = url.href;
  newtab.href = url.href;
  titleEl.textContent = g.name;
  lobby.hidden = true;
  player.hidden = false;
  document.title = g.name + ' · 游戏大厅';
  frame.focus();
}

function closeGame() {
  frame.src = 'about:blank';
  player.hidden = true;
  lobby.hidden = false;
  document.title = '游戏大厅';
  searchEl.focus();
}

$('back').addEventListener('click', closeGame);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !player.hidden) closeGame();
});

searchEl.addEventListener('input', render);

async function boot() {
  try {
    const res = await fetch('./games.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    games = Array.isArray(data.games) ? data.games : [];
    if (!games.length) throw new Error('清单里没有游戏');
    statusEl.textContent = `${games.length} 个游戏`;
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
