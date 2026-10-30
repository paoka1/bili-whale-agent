# 日记分层记忆 Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Task 1–3 由 Codex 实现，Task 4–5 由 Claude 实现；每个 Task 完成后由 Claude 审核再提交。

**Goal:** agent 的日记从「全文读、整篇写」改为「长期记忆 + 近期条目 + 目录与搜索」，日记只追加，网页按条目从新到旧显示。

**Architecture:** `packages/bili/src/diary-entries.ts` 解析两本 Markdown 为条目并统一排序；`diary.ts` 增加追加、记忆读写、近期快照与搜索；`packages/core` 换工具与提示词；`/api/diaries` 多返回记忆和排好序的条目，网页据此渲染。不迁移、不改写旧日记，不加索引文件、数据库或新依赖。

**Tech Stack:** Node ≥22、TypeScript、vitest、zod 4、ai SDK `tool()`、React 19 + Mantine 9。

**Spec:** `docs/superpowers/specs/2026-10-30-diary-memory-design.md`

## Global Constraints

- 沿用「只在边界校验」「测试从简」：一条规则一正一反，不为常量和转发函数写镜像测试。
- 日期按服务器本地时区（`toLocaleDateString('sv-SE')` 那一套），时间从 `ctx.now` 注入；测试用固定时间。
- 字数一律 `Array.from(text).length`；追加大小按 UTF-8 字节。
- 常量在 `packages/bili/src/diary.ts` 导出并被工具 schema 引用：`MEMORY_MAX_CHARS = 3000`、`APPEND_MAX_BYTES = 20 * 1024`、`RECENT_DAYS = 3`、`CATALOG_LIMIT = 100`、`SEARCH_LIMIT = 10`。
- 测试样本只仿照 spec 第 3 节的标题结构合成，不放真实日记正文。
- 不碰真实数据目录，不部署；上线由 Claude 按 spec 第 10 节执行。

## Review Focus

- 公开日记末尾的 `## 看过` 等不带日期的二级标题必须切成独立条目，不能并进最后一篇（Task 1 测试守住）。
- 旧日记是最新在上：同一天多篇按标题时间排，无时间时文件越靠前越新；新追加条目在文件末尾但排序在最前（Task 1、Task 4 测试守住）。
- `diary_read` 的 inputSchema 最外层必须是 object，不用 union（Task 3 测试守住）。
- 追加不能走 200KB 限制的 `writeDiary`，不能读全文再重写（Task 2 测试守住）。
- 长期记忆为空时，快照和提示词都要让她这一轮整理一份（Task 2、3 测试守住）。

---

### Task 1: 条目解析与排序（Codex）

**Files:**
- Create: `packages/bili/src/diary-entries.ts`
- Modify: `packages/bili/src/index.ts`（导出）
- Test: `packages/bili/test/diary-entries.test.ts`

**Interfaces:**
- Produces: `type DiaryWhich = 'public' | 'private'`；`type DiaryEntry = { id: string; which: DiaryWhich; index: number; date: string | null; title: string; markdown: string; bvids: string[] }`；`parseDiary(which: DiaryWhich, markdown: string): DiaryEntry[]`（文件顺序）；`sortEntries(entries: DiaryEntry[]): DiaryEntry[]`（spec 第 5 节顺序，返回新数组）。

- [ ] **Step 1: 写失败测试**，样本仿照 spec 第 3 节：一级标题；`## 2026-10-30 · 午（醒来）`；`## 2026-10-29 · 早（08:44 醒）` 内含 `### 12:12 他回了`；`## 2026-10-29 · 夜（19:41 醒）`；`## 2026-10-29 · 早`，正文里有围栏代码，其中一行 `## 2026-01-01 · 假的`；一条 `## 2026-02-30 · 非法`；末尾 `## 看过`（含两个 BV）和 `## 谁回过我`。以上即文件顺序。
  - `parseDiary` 后：条目数 = 序言 1 + 日期 4 + 非法 1 + 清单 2；`### 12:12 他回了` 留在它那篇里；围栏里的假标题不切条目。
  - `看过` 条目 `date: null`、`title: '看过'`、`bvids` 为那两个 BV；`2026-02-30` 那条 `date: null`。
  - ID 依次为 `public:0`、`public:1`…；`markdown` 拼回去等于原文。
  - `sortEntries` 后标题顺序：`午（醒来）`（10-30）→ `夜（19:41 醒）` → `早（08:44 醒）` → `早`（同日 08:00 估计 vs 08:44，08:44 更晚）→ 未标日期的按文件顺序（序言、非法、看过、谁回过我）。
  - 再加一个用例：同一天两条都无时间、无时段词时，文件里靠前的排前；同一天一条旧格式 `## 2026-10-30 · 早` 与程序追加的 `## 2026-10-30 · 21:30`（在文件末尾）时，21:30 排前。
- [ ] **Step 2: 运行确认失败** `npm test -w packages/bili -- test/diary-entries.test.ts`，预期找不到模块。
- [ ] **Step 3: 实现**：逐行扫描，记录 ``` 围栏状态；行首 `## ` 切条目；日期用 `/^## (\d{4}-\d{2}-\d{2}) · (.*)$/` 取出后用 `new Date(y, m-1, d)` 回检年月日相等；BV 用 `/BV[0-9A-Za-z]{10}/g` 去重。时间键：标题第一个 `\d{1,2}:\d{2}`，否则时段词（早 / 上午 08:00，午 / 中午 / 下午 12:00，晚 / 夜 20:00），否则 -1。
- [ ] **Step 4: 运行通过** 同上命令，预期 PASS。

---

### Task 2: 追加、长期记忆、快照与搜索（Codex）

**Files:**
- Modify: `packages/bili/src/diary.ts`
- Test: `packages/bili/test/diary.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseDiary`、`sortEntries`、`DiaryEntry`。
- Produces:
  - `appendDiary(dataDir: string, which: DiaryWhich, markdown: string, now: number): { entry: string }`——标题 `## YYYY-MM-DD · HH:MM`（本地时区），超 `APPEND_MAX_BYTES`、空正文、围栏外含 `# ` / `## ` 标题时抛 `Error`（工具层会把原因交给模型）。
  - `readMemory(dataDir): string`；`writeMemory(dataDir, markdown): void`（超 `MEMORY_MAX_CHARS` 抛错，不写）。
  - `listEntries(dataDir): DiaryEntry[]`——两本合并后 `sortEntries`。
  - `readDiarySnapshot(dataDir, now): { memory: string; recent: DiaryEntry[]; catalog: { entry: string; which: DiaryWhich; date: string | null; title: string; bvids: string[]; moreBvids: number }[]; total: number; today: string; timeZone: string }`——`recent` 为今天起 `RECENT_DAYS` 个自然日的条目；`catalog` 取前 `CATALOG_LIMIT` 条，`bvids` 最多 5 个。
  - `readDiaryEntry(dataDir, id): DiaryEntry | null`。
  - `searchDiaries(dataDir, query: string, which?: DiaryWhich): { total: number; hits: { entry: string; which: DiaryWhich; date: string | null; title: string; excerpt: string }[] }`——前 `SEARCH_LIMIT` 条，摘录为首个命中前后共约 300 字。

- [ ] **Step 1: 写失败测试**
  - `追加不改旧字节，超过 200KB 仍可追加`：先用 `fs.writeFileSync` 放 210KB 旧文，`appendDiary(..., 'public', '今晚看了猫', 固定时间 2026-10-30 21:30 本地)`；断言新文件以旧 Buffer 开头、结尾含 `## 2026-10-30 · 21:30\n\n今晚看了猫`，私人日记文件不存在；返回的 `entry` 能被 `readDiaryEntry` 读回。
  - `追加正文带二级标题被拒绝`：`'## 看过\n…'` 抛错且文件不变；`'### 小节\n…'` 通过。
  - `记忆超 3000 字拒绝并保留旧内容`：先写 10 字，再写 3001 字抛错，`readMemory` 仍是 10 字；缺文件时 `readMemory` 返回 `''`。
  - `快照只含最近 3 个自然日`：条目日期 10-30、10-28、10-27 与一条 `## 看过`，`now` 为 10-30；`recent` 只有 10-30 与 10-28，`catalog` 含全部 4 条且 `total` 为 4。
  - `搜索按 BV、日期、关键词命中，零命中返回空`：断言 BV 命中 `看过` 条目，`2026-10-27` 命中那天的条目，`猫` 大小写无关命中，`不存在的词` 返回 `{ total: 0, hits: [] }`。
- [ ] **Step 2: 运行确认失败** `npm test -w packages/bili -- test/diary.test.ts`。
- [ ] **Step 3: 实现**。追加用一次 `fs.appendFileSync`（文件不以换行结尾时先补 `\n\n`），新建文件 `mode: 0o600`；记忆用临时文件 + rename，沿用 `writeDiary` 的写法。`readDiaries`、`writeDiary` 保持不变。
- [ ] **Step 4: 运行通过** `npm test -w packages/bili -- test/diary.test.ts test/diary-entries.test.ts test/feed.test.ts`，`feed` 不需要修改。

---

### Task 3: agent 工具与提示词（Codex）

**Files:**
- Modify: `packages/core/src/tools.ts`、`packages/core/src/prompts.ts`、`packages/core/src/scheduler.ts`（跳过看视频的提示）
- Test: `packages/core/test/tools.test.ts`、`prompts.test.ts`、`runner.test.ts`

**Interfaces:**
- Consumes: Task 2 全部函数与常量。
- Produces（工具名与参数，后续网页标签按此）：
  - `diary_read({ entry?: string })`：无 `entry` 返回快照（记忆为空时附 spec 7.1 的提示句）；有 `entry` 返回该条全文，未找到返回 `{ ok: false, reason: '没有这条日记' }`。
  - `diary_append({ which: 'public' | 'private', markdown: string })` → `{ ok: true, entry }`。
  - `memory_write({ markdown: string })` → `{ ok: true, chars }`。
  - `diary_search({ query: string, which?: 'public' | 'private' })`。
  - 删除 `diary_write`。

- [ ] **Step 1: 写失败测试**
  - 工具清单：三种运行都有 `diary_read`、`diary_append`、`memory_write`、`diary_search`，都没有 `diary_write`；原有按来源裁剪的断言保留。
  - `diary_read` 的 inputSchema 转成 JSON Schema 后 `type === 'object'`（用 `z.toJSONSchema`）。
  - 追加 → 默认读取 → 搜索旧文 → 按 ID 回读走通一遍；回读内容包在 `wrapUntrusted` 里、正文里伪造的结束标记不能结束包装；主人昵称不打码。
  - 记忆为空时默认读取结果含「长期记忆是空的」；`memory_write` 3001 字在 schema 拒绝。
  - 提示词：唤醒提示含 `diary_append` 与 `memory_write`，不含 `diary_write`、不含「整篇」；消息提示要求回复前确认是否已回过。不逐句匹配文案。
  - `runner.test.ts` 里模拟的 `diary_write` 调用改为 `diary_append`，请求保护拒绝后仍能追加、取消后不落盘这两条保持通过。
- [ ] **Step 2: 运行确认失败** `npm test -w packages/core`。
- [ ] **Step 3: 实现**：工具接上 bili 函数，走现有 `run` 包装；文字结果用 `wrapUntrusted`，删掉「日记会被整篇覆盖写回」的旧注释并改成「记忆要整篇写回，打码会把昵称永久替换掉」。提示词按 spec 第 8 节改第 1、6、7 步和消息、跳过提示。
- [ ] **Step 4: 运行通过** `npm test -w packages/core`。

---

### Task 4: 日记接口与网页（Claude）

**Files:**
- Modify: `packages/core/src/server/routes.ts`（`/api/diaries`）
- Modify: `packages/web/src/api.ts`、`packages/web/src/labels.ts`、`packages/web/src/pages/Activity.tsx`
- Test: `packages/core/test/server.test.ts`、`packages/web/test/markdown.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `readMemory`、`listEntries`。
- Produces: `GET /api/diaries` → `{ public: string; private: string; memory: string; entries: { public: DiaryView[]; private: DiaryView[] } }`，`DiaryView = { id: string; date: string | null; title: string; markdown: string }`，各本已按 spec 第 5 节排好。

- [ ] **Step 1: 写失败测试**
  - `server.test.ts`：原 `/api/diaries` 断言改为 `toMatchObject({ public: '', private: '# 私人日记', memory: '' })`，并用 `appendDiary` 追加一条后断言 `entries.private[0].title` 是新条目。
  - `markdown.test.tsx`：`toolLabel('diary_append') === '追加日记'`、`memory_write` → `整理记忆`、`diary_search` → `查旧日记`，`diary_write` 仍为 `写日记`。
- [ ] **Step 2: 运行确认失败** `npm test -w packages/core -- test/server.test.ts`、`npm test -w packages/web`。
- [ ] **Step 3: 实现**：路由返回新字段；日记页签按 `entries` 逐条渲染（每条一个小卡片，Markdown 原文渲染）；新增「长期记忆」页签，空时显示「还没整理」；加三个标签。
- [ ] **Step 4: 运行通过**，并在浏览器里用临时数据目录看一遍：新追加条目在最上面，`看过` 等清单在最后，手机宽度不横向滚动。

---

### Task 5: 文档、完整验证与上线（Claude）

**Files:**
- Modify: `README.md`（数据目录表加 `whale-memory.md`）、`docs/TODO.md`（完成后划掉这一条）

- [ ] **Step 1:** `npm run build` 与 `npm test` 全部通过。
- [ ] **Step 2:** 对照 spec 第 11 节逐条核对。
- [ ] **Step 3:** 按 spec 第 10 节上线：备份两本日记 → 部署 → 重启 → 手动唤醒一次 → 检查第一次就整理出长期记忆、新条目追加在末尾、网页显示正常。
- [ ] **Step 4:** 提交。
