# 游戏大厅 · 用游戏学大模型推理与 Agent

这个仓库不是游戏合集，是个**学习工具**：把大模型推理和 Agent 里那些读文档记不住、一上手就踩坑的机制，拆成能动手玩的小游戏。规则讲清楚，玩两把，概念就长在脑子里了。

在线地址：<https://dengbanshi.github.io/game-hub/>

技术上它就是个纯静态站点——没有后端、没有数据库、没有构建步骤，几个 HTML 文件放进任何静态托管就能跑。之所以这么朴素，是为了让「加一个新游戏」的成本低到你可以随手把刚想明白的一个机制做成能玩的东西。

- 大厅：`index.html` + `style.css` + `client.js`，靠 `fetch('games.json')` 读游戏清单
- 游戏：`games/<id>/`，每个游戏是能独立打开的页面，用 iframe 装进大厅
- 共享层：`shared/game-shell.*` 负责统一顶栏、帮助弹层、存档命名空间；`shared/review-panel.*` 负责复盘面板
- 文档：`doc/`，架构、开发规范、每个游戏的知识说明
- 存档：走 `GameShell.store('<id>')`，键名带 `game-hub:` 前缀，游戏之间不会撞车

## 游戏

| 游戏 | 分类 | 讲清什么 |
| --- | --- | --- |
| **投机采样** | 大模型推理 | 猜得越长不一定越快。接受率按位相乘，验证成本照付，最优 k 会随 draft 与 target 的差距塌下来 |
| **上下文窗口** | Agent | 24 格预算下留原文 / 压缩 / 丢弃的取舍，以及压缩的代价为什么要到提问时才结算 |
| 2048 | 游戏 | 热身：状态空间搜索，以及启发式剪枝能省掉多少分支 |
| 贪吃蛇 | 游戏 | 热身：Agent 循环的最小原型，动作延迟为什么会出事 |

前两个是这一版的重点，各自配了完整文档（`doc/games/`），游戏内也内置了「? 玩法与原理」入口。
后两个是热身：它们不直接讲推理机制，作用是把大厅、清单、iframe、帮助弹层这条链路跑通，同时确认「游戏本身得好玩」这件事不能省——一个不好玩的游戏，讲不清任何道理。

## 计划中的游戏

| 知识点 | 玩法设想 |
| --- | --- |
| KV Cache | 两条路径赛跑：每次重算 vs 复用缓存，直观感受「显存换时间」 |
| 批处理与调度 | 请求排队进场，你在吞吐和首字延迟之间做取舍 |
| 工具调用 | 拼装调用链，用有限工具达成目标，错一步全盘重来 |
| ReAct / Agent 循环 | 观察-思考-行动，限定步数通关，看你会不会掉进死循环 |

写这些游戏只有两条硬要求：**规则必须自洽，失败必须可归因**。玩完说不出「我为什么输」，这个游戏就是没做成。

## 复盘面板：四个游戏都有

每局结束时都会出现同一块复盘面板，固定五段——这不是「锦上添花」，是这四个游戏能被叫做教学游戏的唯一理由：

| 段 | 给什么 | 例子（投机采样） |
| --- | --- | --- |
| ① 判定 | 一句话告诉你落在哪个区间 | 「加速比小于 1：你比逐 token 生成还慢」 |
| ② 指标 | 把「用 X 换了 Y」数字化 | 加速比 2.06× / 接受率 71% / 平均接受长度 2.4 |
| ③ 归因 | 指到具体某一轮、某一题、某一步 | 「最亏的是第 5 轮：猜了 16 个，只推进 1 个」 |
| ④ 反事实 | 同一套规则，把另一种做法也跑一遍 | k=1~16 全跑一遍，最优 k=4，k=16 掉到 1.33× |
| ⑤ 建议 | 一条具体动作 | 「这档难度下 k=4 最好，别再往上加」 |

第 ④ 段是重点。前四段只是把分数换个说法，只有对照能让玩家自己得出结论：「原来最优是 k=4，我多猜了 4 倍反而更慢。」

反事实必须是可复现的对照——同一套规则、同一个种子或同一个初始局面，只改一个变量。所以四个游戏的随机数全部走种子 PRNG，不用 `Math.random()`：

- 投机采样：同一难度同一种子，把 k=1/2/4/8/16 各跑一遍整句
- 上下文窗口：题目和你的答案都不变，只把窗口策略换成「全留原文 / 全压摘要 / 什么都不留」重新判分
- 2048：同一个开局，换「只会按下→左→右、永不按上」的机械策略重跑
- 贪吃蛇：同一个开局，换「只朝食物直线走、只在下一步会撞时改向」的机械蛇重跑

这套东西由 `shared/review-panel.js` 统一强制：游戏只提供数据，不写面板的 DOM 和样式。缺了反事实，页面上会直接出现红色告警——不靠自觉，靠机制。

## 开发文档

| 文档 | 内容 |
| --- | --- |
| [doc/ARCHITECTURE.md](doc/ARCHITECTURE.md) | 四层结构、依赖方向、数据契约、复盘面板契约，以及**哪些东西不能改** |
| [doc/DEV-GUIDE.md](doc/DEV-GUIDE.md) | 开发规范：文档要求、帮助入口、复盘要求、代码风格、注释、提交前自查清单 |
| [doc/games/](doc/games/) | 每个游戏的机制说明、玩法学到的内容、规则、代码设计、复盘面板 |

### 五条硬规则（摘要）

1. **每个游戏必须有配套文档** `doc/games/<id>.md`，五段结构固定。
2. **每个游戏必须有帮助入口**，用 `shared/game-shell.js` 自动注入，不许自己实现。
3. **每个游戏必须有复盘面板，且至少一层反事实**，用 `shared/review-panel.js`，不许自己拼 DOM。
4. **关键逻辑必须有关键注释**，代码风格与样式统一。
5. **必须遵循既有架构，只允许增量扩展**；改动 `shared/` 或 `games.json` 的字段结构需要维护者审核。

完整版见 [DEV-GUIDE.md](doc/DEV-GUIDE.md)。

## 目录结构

```
game-hub/
├── index.html              大厅入口
├── style.css               大厅样式（不含任何游戏样式）
├── client.js               清单读取、分类筛选、iframe 开关、覆盖层消息
├── games.json              分类 + 游戏清单（唯一的数据入口）
├── .nojekyll               告诉静态托管别用 Jekyll 处理
│
├── shared/                 ← 所有游戏共用，改动需审核
│   ├── game-shell.css      顶栏 / 帮助弹层样式（只用 .gh- 前缀）
│   ├── game-shell.js       顶栏注入、帮助弹层、存档封装、Esc 冲突处理
│   ├── review-panel.css    复盘面板样式（只用 .ghr- 前缀）
│   └── review-panel.js     复盘面板的五段契约与渲染
│
├── games/                  ← 每个子目录 = 一个能独立打开的游戏
│   ├── speculative/        投机采样（index.html + game.css + game.js）
│   ├── context-window/     上下文窗口（+ scenario.js 纯数据）
│   ├── g2048/              2048（index.html + game.js）
│   └── snake/              贪吃蛇（index.html + game.js）
│
└── doc/                    ← 文档是交付物的一部分
    ├── ARCHITECTURE.md
    ├── DEV-GUIDE.md
    └── games/{speculative,context-window,g2048,snake}.md
```

## 分类

大厅顶部按分类筛选，目前是 `Agent` / `大模型推理` / `游戏`，`全部` 是内置的，不用写进清单。分类声明在 `games.json` 的 `categories` 里，顺序即标签顺序：

```json
"categories": [
  { "id": "agent", "name": "Agent" },
  { "id": "inference", "name": "大模型推理" },
  { "id": "game", "name": "游戏" }
]
```

- 每个游戏用 `category` 字段挂到某个 `id` 上；没写 `category` 的游戏只出现在「全部」里。
- 挂了一个没声明的 `category`，大厅会自动补一个同名标签，不会让游戏凭空消失。
- 标签后面那个数字是当前分类下的游戏数，减到 0 就显示「正在做」——空分类不该藏起来，它本身就是进度条。
- 支持直达链接：`#agent`、`#inference`、`#game`。

## 本地预览

必须用 http 服务器打开，**不能双击 HTML**：`file://` 协议下浏览器会拒绝 `fetch('./games.json')`。

```bash
cd game-hub
python -m http.server 8123
# 打开 http://127.0.0.1:8123/
```

或者 `npx serve .`。

## 加一个新游戏

加之前先回答一个问题：这个游戏要讲清哪个机制？想不清楚就先别写代码，否则做出来的只是个能点的小玩具。

完整流程、文件模板、自查清单在 **[doc/DEV-GUIDE.md](doc/DEV-GUIDE.md)**，这里只列最小步骤：

1. 建目录 `games/<新id>/`，三个文件：`index.html`（骨架）、`game.css`、`game.js`。
2. `index.html` 里必须有 `<header id="gh-bar">` 和 `<div id="gh-help-source" hidden>`，并引入 `shared/game-shell.css|js` 与 `shared/review-panel.css|js`——帮助按钮和复盘面板都由共享层提供，不要自己写。
3. 结束时调 `GameReview.show({ verdict, metrics, attribution, counterfactual, advice })`；反事实必须可复现（同种子 / 同开局，只改一个变量）。
4. 写 `doc/games/<id>.md`（五段：机制 / 能学到什么 / 规则 / 代码设计 / 复盘面板）。
5. 在 `games.json` 的 `games` 数组里加一项：

```json
{
  "id": "your-game",
  "name": "显示名",
  "category": "inference",
  "version": "1.0.0",
  "contentCode": 1,
  "entry": "index.html",
  "doc": "doc/games/your-game.md"
}
```

`id` 必须等于目录名（大厅用它拼路径）。`contentCode` 是同一版本号的源码修订计数，改了内容但版本号没变就 +1。

6. 刷新大厅，跑一遍 [自查清单](doc/DEV-GUIDE.md#7-提交前自查清单)。

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

## 部署到 GitHub Pages（推荐）

这个站没有构建步骤，所以直接用「从分支部署」，不需要写 Actions：

1. 在 GitHub 新建仓库 `game-hub`。选 Public，**不要**勾选初始化 README / .gitignore（本地已经提交好了）。
2. 本地推送：

```bash
cd game-hub
git remote add origin https://github.com/<你的用户名>/game-hub.git
git push -u origin main
```

3. 仓库 → Settings → Pages → Build and deployment：
   - Source 选 `Deploy from a branch`
   - 分支选 `main`，目录选 `/ (root)`
   - 点 Save
4. 等 30 秒到几分钟，访问：

```
https://<你的用户名>.github.io/game-hub/
```

几个要点：

- 根目录的 `.nojekyll` 让 Jekyll 不参与处理，下划线开头的文件也不会被吞掉。
- 推送后自动重新发布，不用手动点「更新」；但有约 10 分钟的 CDN 缓存，刚改完看不到变化先清缓存。
- 项目页地址带 `/game-hub/` 前缀，所以资源只能用相对路径。
- 以后如果想把源码和产物分到两个分支（像参考项目那样用 `gh-pages`），改成 GitHub Actions 的 `actions/upload-pages-artifact` + `actions/deploy-pages` 流程即可。
- 国内访问 GitHub Pages 时快时慢，这是线路问题不是配置问题；要稳定就用下面的国内平台。

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
