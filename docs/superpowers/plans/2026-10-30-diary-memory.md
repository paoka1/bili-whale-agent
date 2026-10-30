# 日记分层记忆与迁移 Implementation Plan

日期：2026-10-30
状态：实现前方案，以下均未开始

**Goal:** 将 agent 的全文日记读写改为「长期记忆 + 近期经历 + 目录与搜索」，提供保留旧正文的显式迁移脚本。

**Architecture:** 在 `packages/bili` 内解析现有 Markdown，并实现追加、记忆文件与迁移；`packages/core` 定义工具和提示词；网页只补活动名称。保留原日记文件、`readDiaries` 与 HTTP 全文接口，不引入索引文件、数据库或新依赖。

**Spec:** `docs/superpowers/specs/2026-10-30-diary-memory-design.md`

## Global Constraints

- 沿用现有 Node ≥22、纯 ESM、TypeScript strict、npm workspaces，以及原计划的「只在边界校验」「测试从简」。
- 用现有 `BiliContext.now` 注入时间，日期按服务器本地时区计算；测试用固定时间。
- zod 在工具边界校验输入，迁移脚本在命令行边界校验参数，本地 Markdown 在解析边界处理旧格式。内部函数不重复检查。
- 不修改真实数据、不部署服务；迁移实现先用临时目录与合成旧日记验证。真实迁移按设计文档中的上线步骤单独执行。
- 每个 Task 先补能守住行为的测试，再实现；一个规则一正一反，不穷举无关输入，不为常量、转发函数写镜像测试。

## Review Focus

- 追加不能走受 200KB 限制的旧覆盖函数；目录也不能无界地交给模型。
- 解析器必须保留序言、未标日期的旧正文、围栏内的伪日期标题。
- 搜索返回摘要后必须有按 ID 分页读全文的入口，不能让旧记忆只剩摘要。
- 迁移不改历史字节，不能截断候选，也不能用候选覆盖已有长期记忆。
- 工具清单、runner 模型替身、取消测试和历史工具标签一起调整，不能只改唤醒提示。

---

### Task 1: 统一日记解析与条目视图

**Files:**
- Create: `packages/bili/src/diary-entries.ts`
- Test: `packages/bili/test/diary-entries.test.ts`

**Interfaces:**
- `DiaryEntry = { id: string; which: 'public' | 'private'; date: string | null; title: string; markdown: string; bvids: string[] }`
- `parseDiary(which, markdown): DiaryEntry[]`：只解析，不读文件；序言与无日期正文也生成条目。原 Markdown 保存在 `markdown` 中。
- 共享条目排序与自然日辅助函数，用于阅读、搜索和迁移；只在日记领域内复用，不扩成通用 Markdown 框架。

- [ ] **Step 1:** 合成两天、多时段、序言、三级小标题与围栏中日期标题的旧文；断言条目边界、BV、ID 与原文片段。
- [ ] **Step 2:** 实现按行扫描，记录围栏状态与二级日期标题，真实校验年月日，不用日期自动进位接受非法日期。
- [ ] **Step 3:** 加一个跨月与本地午夜的日期用例，确认最近 3 个自然日的判断；无日期不混入近期。
- [ ] **Step 4:** `npm test -w packages/bili -- test/diary-entries.test.ts`。

---

### Task 2: 追加、长期记忆与有限阅读

**Files:**
- Modify: `packages/bili/src/diary.ts`、`packages/bili/src/index.ts`
- Test: `packages/bili/test/diary.test.ts`

**Interfaces:**
- 保留 `readDiaries`、`writeDiary`、活动日志接口。
- 新增 `appendDiary(dataDir, which, markdown, now)`、`readMemory(dataDir)`、`writeMemory(dataDir, markdown)`。
- 新增 `readDiaryContext(dataDir, now)`、`readDiaryCatalog(dataDir, offset)`、`readDiaryEntry(dataDir, entry, offset)`、`searchDiaries(dataDir, opt)`；返回形状按 spec 5，带总数、分页偏移与截短说明。
- 字数、单次追加字节数、阅读预算在 bili 日记模块导出常量，供工具 schema 引用；原子写记忆复用原日记的临时文件 + rename 做法，不为此重构通用存储层。

- [ ] **Step 1:** 日记先放入超过 200KB 的旧文，再追加一篇；断言旧字节前缀不变、另一本文字不变，生成正确日期标题。旧 `writeDiary` 的兼容测试保留。
- [ ] **Step 2:** 测试记忆正常原子覆盖、超限保留旧内容、缺文件为空与读取失败报错；非法工具输入留 Task 3，不在内部重复穷举。
- [ ] **Step 3:** 实现固定文件名的同步追加与记忆读写，文件权限沿用 0600，单本总量不限。
- [ ] **Step 4:** 测试近期按自然日筛选，超过阅读预算有定位与回读偏移；超过 100 条的目录可翻完；旧长篇可分段拼回原文。
- [ ] **Step 5:** 测试关键词 / BV / 日期搜索、摘要与零命中，用字面量匹配，分页不丢项；实现这些查询，不增加持久化索引。
- [ ] **Step 6:** `npm test -w packages/bili -- test/diary.test.ts test/diary-entries.test.ts test/feed.test.ts`；原 `feed` 不需要修改。

---

### Task 3: agent 工具与提示词

**Files:**
- Modify: `packages/core/src/tools.ts`、`packages/core/src/prompts.ts`、`packages/core/src/scheduler.ts`
- Modify: `packages/web/src/labels.ts`
- Test: `packages/core/test/tools.test.ts`、`prompts.test.ts`、`runner.test.ts`、`scheduler.test.ts`，`packages/web/test/markdown.test.tsx`

**Interfaces:**
- `diary_append({ which, markdown })`、`memory_write({ markdown })`、`diary_search({ query, which?, offset?, limit? })`。
- `diary_read` 用三种互斥 schema 形状支持默认快照、目录页、按条目回读；边界按 spec 5。
- 新工具使用现有 `run`，不额外加网络请求或绕过取消检查；所有文字结果用 `wrapUntrusted`，本地记忆不经主人身份打码。

- [ ] **Step 1:** 更新工具白名单测试：有三个新工具、没有 `diary_write`；保留按来源裁剪的现有断言。
- [ ] **Step 2:** 将旧日记工具测试改为追加 → 默认阅读 → 搜索旧文 → 按 ID 回读，覆盖回读不打码与伪结束标记；另测超大追加、超长记忆在 schema 拒绝。
- [ ] **Step 3:** 接上 bili 函数；修正「日记会被整篇覆盖」的旧注释，保持现有取消与错误传播方式。
- [ ] **Step 4:** 修改唤醒、消息、跳过看视频提示；第 7 步收到反馈后按需维护长期记忆。提示测试守住追加与按需搜索，不逐句匹配文案。
- [ ] **Step 5:** runner 中模拟 `diary_write` 的调用改成 `diary_append`，确认请求保护拒绝后仍能追加、取消后不能落盘；服务端原日记读取测试继续用 `writeDiary` 造数据。
- [ ] **Step 6:** 给新工具加中文标签，保留旧标签；只验证活动显示需要的映射，不修改页面组件。
- [ ] **Step 7:** `npm test -w packages/core`、`npm test -w packages/web`。

---

### Task 4: 显式迁移与恢复

**Files:**
- Create: `packages/bili/src/diary-migration.ts`、`scripts/migrate-diaries.mjs`
- Modify: `packages/bili/src/index.ts`、根 `package.json`
- Test: `packages/bili/test/diary-migration.test.ts`

**Interfaces:**
- `previewDiaryMigration(dataDir)`：只读，生成统计、候选与来源。
- `migrateDiaries(dataDir, opt)`：检查状态、备份、初始化不存在的记忆、最后写成功标记，返回结构化报告。
- CLI 参数：`--data <dir>`、`--apply`、`--memory <file>`。默认预览不写文件；命令参数错误退出 2，执行失败退出 1，成功退出 0。
- `npm run migrate-diaries -- ...` 仅作为薄入口，从已构建的 bili 包导入实现。

- [ ] **Step 1:** 用临时数据目录构造公开 / 私人旧文，含重复的偏好与待办、无日期序言、同日不同来源；验证按 spec 规则选最新小节，来源正确，预览前后目录内容一致。
- [ ] **Step 2:** 实现小节摘取，复用 Task 1 条目解析；不做模型总结，不推断无标题内容。
- [ ] **Step 3:** 实现备份、已有记忆保留、3000 字上限、显式记忆文件、最后写版本标记；迁移报告不含全文。SHA-256 使用 Node 内置 crypto。
- [ ] **Step 4:** 测试应用前后日记 Buffer 完全一致、备份与原文相同、再次执行无变化；超长候选拒绝后传整理稿可完成，已有记忆不会被整理稿覆盖。
- [ ] **Step 5:** 注入一次写成功标记失败，验证原日记与已创建记忆仍可用、重新执行可完成；另测备份失败时未写记忆或成功标记。不为此引入通用事务框架。
- [ ] **Step 6:** 实现薄脚本，`node scripts/migrate-diaries.mjs --data <临时目录>` 预览；构建后用子进程跑一次 `--apply` 与重复运行，验证参数、退出状态及默认路径解析接线。
- [ ] **Step 7:** `npm test -w packages/bili -- test/diary-migration.test.ts`。

---

### Task 5: 文档与完整验证

**Files:**
- Modify: `README.md`、`docs/deploy-systemd.md`、`docs/TODO.md`
- Modify: `docs/superpowers/specs/2026-10-29-bili-whale-agent-design.md`（在旧记忆 / 工具章节加新方案引用，保留首版设计历史）

- [ ] **Step 1:** README 数据目录表增加长期记忆、迁移标记与备份目录；补构建、预览、整理超长候选、停服务、应用、启动的命令。标明预览可能输出私人日记摘录。
- [ ] **Step 2:** systemd 更新文档补日记升级时停服务的顺序与回退方法，不把普通 `git pull` 更新改成每次自动迁移。
- [ ] **Step 3:** `npm test` 与 `npm run build`。前面测试已通过的规则不再重复扩测，只有本轮失败或新改动才追加验证。
- [ ] **Step 4:** 在临时数据目录手工走一遍旧文预览 → 应用 → 分层阅读 → 搜索旧 BV → 追加 → 网页接口全文读取；再检查空目录无需迁移也可使用。
- [ ] **Step 5:** 对照 spec 8 验收，记录实际测试结果；全部完成后再把 TODO 改为已完成。真实服务器迁移不作为本地实现已完成的默认事实。
