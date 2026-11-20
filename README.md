# 游戏大厅 · 静态站版

纯静态的网页游戏大厅。没有后端、没有数据库、没有构建步骤：三个 HTML 文件放进任何静态托管就能跑。

- 大厅：`index.html` + `style.css` + `client.js`，靠 `fetch('games.json')` 读游戏清单
- 游戏：`games/<id>/index.html`，每个游戏一个自包含文件，用 iframe 装进大厅
- 存档：各游戏自己写 `localStorage`，键名统一带 `game-hub-` 前缀，方便以后迁移

## 目录结构

```
game-hub/
├── index.html          大厅入口
├── style.css           大厅样式
├── client.js           读清单、渲染卡片、iframe 开关
├── games.json          游戏清单（新游戏只需要改这里）
├── .nojekyll           告诉静态托管别用 Jekyll 处理
└── games/
    ├── conway/index.html   康威生命游戏
    ├── g2048/index.html    2048
    └── snake/index.html    贪吃蛇
```

## 本地预览

必须用 http 服务器打开，**不能双击 HTML**：`file://` 协议下浏览器会拒绝 `fetch('./games.json')`。

```bash
cd game-hub
python -m http.server 8123
# 打开 http://127.0.0.1:8123/
```

或者 `npx serve .`。

## 加一个新游戏（三步）

1. 新建 `games/<新id>/index.html`，写完直接能跑（想返回大厅就放一个 `<a href="../../index.html">`）。
2. 在 `games.json` 的 `games` 数组里加一项：

```json
{
  "id": "your-game",
  "name": "显示名",
  "version": "1.0.0",
  "contentCode": 1,
  "entry": "index.html"
}
```

3. 刷新大厅。`contentCode` 是同一版本号的源码修订计数，改了内容但版本号没变就 +1（照抄参考站点的做法，方便区分缓存）。

## 部署到 Gitee Pages

先说清楚现状，免得白折腾：Gitee Pages **必须实名认证**、**push 后要手动点更新**、**有内容审核**、**免费版不能绑自定义域名**，而且社区里长期有“服务已停止”的说法。能用，但别指望它省心。

1. 登录 gitee.com，去「设置 → 实名认证」把身份证那套走完（不认证就没有 Pages 入口）。
2. 新建仓库，名字比如 `game-hub`，公开，不要勾选初始化 README。
3. 本地推上去：

```bash
cd game-hub
git init
git add -A
git commit -m "静态游戏大厅"
git branch -M main
git remote add origin https://gitee.com/<你的用户名>/game-hub.git
git push -u origin main
```

4. 仓库页 → 顶部「服务」→「Gitee Pages」。
5. 部署分支选 `main`，部署目录留空（根目录），有「强制 HTTPS」就勾上。
6. 点「启动服务」，等构建完成，访问：

```
https://<你的用户名>.gitee.io/game-hub/
```

7. **以后每次 push 完，回到这个页面点一次「更新」**。不点，线上永远是旧版本——这是 Gitee Pages 免费版最反人类的设定，也是大多数人以为“部署失败”的真实原因。

### 三个必踩的坑

- **路径必须相对**。项目页地址带着 `/game-hub/` 前缀，写成 `/style.css` 会去根域找，必然 404。本项目全程用 `./` 就是为这个。
- **更新有延迟**。审核 + 缓存，几分钟内看到旧页面是正常的，先清缓存再用隐身窗口确认。
- **没有 Pages 入口**。部分账号/仓库暂时开不了，不是你操作错了。换台平台更省时间，代码不用改。

## 其他平台（同一套文件，零改动）

| 平台 | 特点 | 适合 |
| --- | --- | --- |
| 腾讯云 EdgeOne Pages | 国内节点、免费、Git 自动部署、无需备案 | 想让国内朋友秒开 |
| Cloudflare Pages | 全球 CDN、免费额度大、自动部署 | 想省事又要稳 |
| GitHub Pages | 最成熟，100GB/月软限制，10 分钟构建上限 | 已有 GitHub 仓库 |
| 自己的服务器 + Nginx | 完全可控，但要备案和证书 | 要长跑的项目 |

无论放哪，注意这几点：站点是公开的，别把密钥写进前端；单仓库别塞大资源（视频、素材包），静态托管都有体积和流量限制；`iframe` 里的游戏和大厅同源，能互相访问 `localStorage`，所以键名前缀别撞车。

## 已知限制

- 没有 Service Worker，断网打不开；想要离线能力，可以加一个 `sw.js` 做预缓存，但要自己处理版本更新。
- 存档只在当前浏览器，换设备/清缓存就没了。要做云存档就必须上后端。
- 没有路由，全靠 `#` 之外的路径；新增页面直接加文件即可，不需要 SPA 那套。
