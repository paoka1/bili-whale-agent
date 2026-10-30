# CLAUDE.md

给在这个仓库里工作的 Claude（以及其他编码 agent）看的说明。面向用户的介绍见 README.md。

## 项目是什么

一个常驻程序：让一个 AI 用 B 站小号按作息醒来、看视频、写日记、把值得看的私信或评论分享给「主人」。自带 agent（Vercel AI SDK，任意 OpenAI 兼容接口），网页上配置和查看活动。

npm workspaces，三个包：

| 包 | 内容 |
|---|---|
| `packages/bili` | B 站能力，不依赖 LLM。`api.ts`（请求、WBI 签名、缓存）、`traffic.ts`（请求保护：频率、预算、写冷却、风控暂停）、`comment.ts` / `fav.ts` / `dm.ts`（写操作和闸门）、`inbox.ts` / `owner-dm.ts`（收件箱、主人私信）、`diary.ts` + `diary-entries.ts`（日记只追加、长期记忆、目录、搜索）、`feed.ts` / `search.ts` / `brief.ts` / `frames.ts`（选题与看视频） |
| `packages/core` | agent 与服务。`tools.ts`（给模型的工具，做成的事自动记进动态）、`prompts.ts`、`runner.ts`、`scheduler.ts`（作息、监听、重试、推送）、`night.ts`（作息计划）、`config.ts`、`server/`（hono：`routes.ts` 接口、`auth.ts` 登录与 CSRF）、`cli.ts` / `bin.ts` |
| `packages/web` | 网页，React 19 + Mantine 9 + Vite |

## 常用命令

```bash
npm install
npm run build                    # bili、core 用 tsc，web 用 vite；产物在各包 dist/
npm test                         # 三个包全量（约 40 秒）
npm test -w packages/web         # 只跑一个包（bili / core / web）
npm start -- --data <目录>        # 启动服务，默认 127.0.0.1:8787
```

改哪个包先跑哪个包的测试，提交前再跑一次全量。

## 约定

- 只在边界校验（工具入参、HTTP 入参、本地文件读入），内部函数信任类型，不写防御性重复检查。
- 测试从简：一条规则一个正例一个反例，不为常量和转发函数写镜像测试。修 bug 先写一个会失败的测试。
- 注释、提示词、网页文案都用中文；提交信息用英文（`feat(web): …`、`fix(bili): …`）。
- `package-lock.json` 里不能混进 npmmirror 的地址（`grep -c npmmirror package-lock.json` 应为 0），出现了就换回 `registry.npmjs.org`。
- 不碰真实数据目录（默认 `~/.bili-whale`）。看页面、截图一律用演示数据（见下）。仓库是公开的，不要把真实日记、昵称、mid、服务器地址写进代码、测试或文档。

## 网页（packages/web）

- `main.tsx`：Mantine 主题，全局字号在这里调（xs 14 / sm 15 / md 16 / lg 18 / xl 20）。
- `App.tsx`：顶栏（活动 / 配置、退出）和登录、首次设置的切换。
- `pages/Activity.tsx`：状态栏（醒着时显示「已做」进度）、她最近的信、待审草稿、页签：动态（相邻重复合并 ×N）/ 运行记录 / 日记 / 私人日记（月历筛选，`calendar.tsx`）/ 长期记忆。
- `pages/Config.tsx`：配置页，顶部分块导航；密钥和配置一起保存。
- `labels.ts`：动态类型、运行状态、工具名的中文名称。新增工具或动态类型要在这里加名字。
- `api.ts`：接口类型和请求封装（401 / CSRF 失效自动回登录页）。接口本身在 `packages/core/src/server/routes.ts`。
- 测试在 `test/markdown.test.tsx`（纯函数和组件），页面效果靠下面的方法人工看。

## 看网页效果

Vite 开发服务器没有配 API 代理，看页面要用构建产物 + 本机临时实例：

1. `npm run build`（只改了网页时 `npm run build -w packages/web` 就行，服务直接读 `dist`，刷新即可）。
2. 造一份演示数据：`node scripts/demo-data.mjs <一个空目录>`。只往空目录写，BV 号都是假的。
3. 启动临时实例：`TZ=Asia/Shanghai node packages/core/dist/bin.js start --data <那个目录> --port 8791`。在 Claude Code 桌面版里，可以写一个临时的 `.claude/launch.json`，用浏览器面板的 `preview_start` 启动，用完删掉。
4. 终端会打印 8 位设置码。在网页上用设置码设一个临时密码登录（这是本机的测试实例，随机生成即可）。
5. 电脑宽度和手机宽度（375px）各看一遍，手机上不能有横向滚动。
6. 用完关掉实例。

## README 截图

`docs/images/activity.png`、`docs/images/diary.png` 是用演示数据截的。界面改了要重截时：

1. 按上面 2–3 步起一个**刚启动、还没设过密码**的临时实例。
2. `node scripts/screenshot.mjs --url http://127.0.0.1:8791 --code <设置码>`：用本机的无头 Chrome / Edge 按 2 倍像素密度截 PNG，写进 `docs/images/`。脚本自己用设置码登录，不需要额外依赖。

## 部署

部署到真实服务器的方式（地址、步骤）不在仓库里：在维护者的电脑上见 `CLAUDE.local.md`（不提交）。通用的 systemd 部署说明见 `docs/deploy-systemd.md`。

## 文档

- `docs/superpowers/specs/`、`docs/superpowers/plans/`：设计文档和实现计划（首版、日记分层记忆）。
- `docs/TODO.md`：待办。
