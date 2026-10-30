#!/usr/bin/env node
// 往一个空的数据目录里写一套演示用的假数据：信、动态、运行记录、两本日记、长期记忆。
// 用来在本机看网页效果、给 README 截图；BV 号都是 BV1Demo… 这种假号，不碰真实账号。
// 用法：node scripts/demo-data.mjs <数据目录>，然后 node packages/core/dist/bin.js start --data <数据目录> --port 8791
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('用法：node scripts/demo-data.mjs <数据目录>')
  process.exit(2)
}
if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
  console.error(`${dir} 不是空目录；为免覆盖真实数据，只往空目录里写`)
  process.exit(2)
}
fs.mkdirSync(dir, { recursive: true })
const write = (name, text) => fs.writeFileSync(path.join(dir, name), text)
const json = (name, value) => write(name, JSON.stringify(value, null, 2))
const jsonl = (name, rows) => write(name, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

// 时间都相对现在往前推，页面上的「上次醒来」不会晚于服务器时间
const now = Date.now(), H = 3600_000, M = 60_000
const iso = (ms) => new Date(ms).toISOString()
const day = (ms) => new Date(ms).toLocaleDateString('sv-SE')
const hm = (ms) => new Date(ms).toTimeString().slice(0, 5)
const wake = now - 3 * H, reply = now - 6 * H, lastNight = now - 20 * H

json('config.json', { dryRun: false })

const tools = ['quota_status', 'diary_read', 'feed', 'search', 'search', 'video_brief', 'video_brief', 'video_brief', 'video_brief',
  'video_deep', 'video_deep', 'inbox', 'fav', 'dm_owner', 'diary_append', 'diary_append', 'log']
const letter = '今天就推一条：一个手工博主用纸板复刻了老式街机，按键真的能按，屏幕里跑的是自己写的小游戏。'
  + '十二分钟，前半段讲结构，后半段全是调试翻车，弹幕一直在笑。\n\n'
  + '另外收藏了一期讲猫咪行为的科普，三个月后大概还会想翻出来看。你上次说别推攻略，这轮一条都没碰。'
const run = (id, kind, end, minutes, names, finalText) => ({
  id, kind, startedAt: iso(end - minutes * M), endedAt: iso(end), status: 'ok', steps: names.length > 5 ? 10 : 3,
  toolCalls: names.map((name) => ({ name, ok: true })), draftsAdded: 0, finalText,
})
jsonl('runs.jsonl', [
  run('demo-1', 'wake', lastNight, 9, tools, '昨晚的信。'),
  run('demo-2', 'owner-message', reply, 2, ['diary_read', 'dm_owner', 'diary_append', 'memory_write'], '主人说喜欢昨天的手工视频，回了一句，并把「手工 / 复刻」记进了长期记忆。'),
  run('demo-3', 'wake', wake, 9, tools, letter),
])

const failed = '评论监听失败，稍后自动重试：收件箱读取失败（reply，code=-1：请求失败（网络异常）），请稍后重试'
const log = (ms, kind, target, note) => ({ at: iso(ms), kind, target, note })
jsonl('whale-log.jsonl', [
  log(lastNight - 3 * M, 'watch', 'BV1Demo00101', '深读：猫咪为什么喜欢纸箱，兽医讲得很实在'),
  log(lastNight - M, 'share', 'BV1Demo00102', '私信推给主人：一段八分钟的地铁模型延时摄影'),
  log(lastNight, 'round', 'BV1Demo00102', '昨晚：候选七条，推了地铁模型；动画类今天都偏旧'),
  log(lastNight, 'run', 'demo-1', '运行 wake：ok，9 步，17 次工具调用，新增 0 条草稿'),
  log(reply - M, 'reply_owner', null, '私信回主人：记下了，手工复刻这类以后多找。'),
  log(reply, 'run', 'demo-2', '运行 owner-message：ok，3 步，4 次工具调用，新增 0 条草稿'),
  log(reply + 20 * M, 'scheduler', null, failed),
  log(reply + 24 * M, 'scheduler', null, failed),
  log(reply + 31 * M, 'scheduler', null, failed),
  log(wake - 5 * M, 'watch', 'BV1Demo00201', '深读：纸板复刻老式街机，按键能按'),
  log(wake - 4 * M, 'watch', 'BV1Demo00202', '深读：猫咪行为科普，讲踩奶和蹭人'),
  log(wake - 3 * M, 'fav', 'BV1Demo00202', '科普讲得清楚，三个月后还想翻出来看'),
  log(wake - 2 * M, 'share', 'BV1Demo00201', '私信推给主人：纸板复刻老式街机，后半段全是调试翻车'),
  log(wake, 'round', 'BV1Demo00201', '推了纸板街机（16 分）；收藏猫咪科普；攻略类一条没碰'),
  log(wake, 'run', 'demo-3', '运行 wake：ok，10 步，17 次工具调用，新增 0 条草稿'),
])
json('quota.json', { log: [{ at: iso(wake - 2 * M), type: 'dm', target: 'BV:BV1Demo00201', note: '纸板街机', auto: true, share: true }] })
json('favorites.json', { items: [{ bvid: 'BV1Demo00202', aid: 1, title: '猫咪行为科普', up: 'UP', at: iso(wake - 3 * M), reason: '科普讲得清楚，三个月后还想翻出来看', kind: '科普' }] })

const heading = (ms) => `## ${day(ms)} · ${hm(ms)}`
write('whale-diary.md', `# 小鲸 · 日记

${heading(now - 96 * H)}

第一次醒来。先把口味表读了三遍，猫、手工、怀旧剪辑。

${heading(now - 48 * H)}

翻到一个做微缩地铁站的人，屏蔽门和车门同步开关，我看了两遍。

${heading(lastNight)}

候选七条，动画类都偏旧。推了一段地铁模型延时摄影，八分钟，安静得刚好。

| 视频 | 结论 |
|---|---|
| BV1Demo00101 | 深读，没推 |
| BV1Demo00102 | 推了 |

${heading(wake)}

今天最开心的是那台纸板街机。按键真的能按，屏幕里跑的是他自己写的小游戏，后半段一直在修接触不良，弹幕笑成一片。

### 本轮 BV

| 视频 | 结论 |
|---|---|
| BV1Demo00201 | 推给主人，16 分 |
| BV1Demo00202 | 收藏 |
`)
write('whale-diary-private.md', `# 私人日记（不外传）

${heading(lastNight)}

### 偏好校准

- 安静的长镜头他会看完，不一定要节奏快。

${heading(reply)}

### 偏好校准

- 他回了「手工视频不错」，手工 / 复刻这条线确认。

${heading(wake)}

### 偏好校准

- 这轮还是没碰攻略，继续保持。
`)
write('whale-memory.md', `## 主人口味（校准结论）

- 爱看：猫咪、手工与复刻、怀旧向剪辑。
- 安静的长镜头也能看完，不必只挑快节奏。
- 攻略、作业类不推。

## 在跟进的待办

- 找一期正经的模型制作教程。
`)
console.log(`演示数据已写入 ${dir}`)
