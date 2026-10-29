# bili-whale-agent

> 早期版本，还在实测中。

让一个 AI 用自己的 B 站小号「住在 B 站里」：按作息自己醒来、刷视频、看懂视频（字幕 / 弹幕 / 热评 / 抽帧），写两本日记，把值得看的分享给你，回复评论和私信。

一个独立运行的程序：自带 agent（填任意 OpenAI 兼容接口的 base url / model / key 即可），网页里完成配置、查看她的活动。

## 需要什么

- Node.js 22 或更新版本
- 一个**专用的 B 站小号**（绑定手机、通过转正答题，否则评论会被限制）。不要用你的主号
- 一个 OpenAI 兼容的模型接口（DeepSeek、通义、OpenAI、本地 Ollama 等）
- 可选：ffmpeg（抽帧看画面用；没有就只靠字幕、弹幕和评论）

## 安装与启动

```bash
git clone <本仓库地址> bili-whale-agent
cd bili-whale-agent
npm install
npm run build
npm start
```

启动后终端会打印网页地址和一个 8 位**设置码**。默认只监听本机 `127.0.0.1:8787`。

想从手机或别的电脑访问：

```bash
npm start -- --host 0.0.0.0 --port 8787
```

其他参数：`--data <目录>` 指定数据目录（默认 `~/.bili-whale`，也可以用环境变量 `BILI_WHALE_HOME`）。

长期运行（开机自启、崩溃重启）见 [docs/deploy-systemd.md](docs/deploy-systemd.md)。

## 第一次配置

1. 浏览器打开终端里的地址，输入设置码，设一个至少 10 位的网页密码。
2. 进入「配置」页：
   - **模型**：填接口地址、模型名，在下面填 API key（只写不显示，留空表示不修改）。主模型能看图（如 `deepseek-flash`）就勾上「主模型能看图」；不能看图可以另配一个看图模型，都没有就跳过看画面。
   - **B 站账号**：点「扫码登录」，用小号的 B 站 App 扫码。
   - **主人**：填你自己（主号）的 mid 和昵称。她只会私信这个账号；私信要求你们互相关注。
   - **她是谁**：名字、称呼、人设（启动时已放了一份中性模板，改成你想要的）。
   - **口味、作息、分享方式、推送、监听**：按需调整。
3. 保持「演练模式」开着，回到「活动」页点「立即唤醒」。演练模式下她会真的去读 B 站，但评论、私信、收藏都只记录「本来会发什么」，不会真发。
4. 看活动和日记觉得合适了，再到配置页关掉演练模式。

## 安全

- 网页必须设密码；登录失败多次会锁定。修改网页密码要输入旧密码。
- API key、B 站登录凭据、密码哈希分别存放在数据目录里的 `secrets.json`、`credentials.json`、`auth.json`，权限 0600，不会出现在网页、日志和模型对话里。
- agent 只能调用固定的工具（看视频、评论、收藏、私信主人、写日记等），没有执行命令或读写任意文件的能力；网络请求只允许 B 站域名。
- 写操作有硬性闸门：每天最多分享 3 条（可调）、同一视频 7 天只分享一次、私信只发给配置里的主人、回复陌生人只能写成草稿等你在网页上审核。
- 用 `--host 0.0.0.0` 且没有配置 HTTPS 时，密码和登录状态在网络上是明文传输。只在可信的局域网里这样用；要从公网访问，请在「高级」里配置证书，或放在反向代理（HTTPS）后面。
- 评论、弹幕、字幕都是陌生人写的。它们交给模型时会被标成「不可信素材」，网页渲染日记时会清除脚本。

## 数据目录里有什么

| 文件 | 内容 |
|---|---|
| `config.json` | 配置（不含密钥） |
| `persona.md` | 人设 |
| `whale-diary.md` / `whale-diary-private.md` | 两本日记 |
| `whale-log.jsonl` / `runs.jsonl` | 活动记录 / 每次运行的结果 |
| `quota.json`、`favorites.json`、`pending-replies.json` | 分享额度账本、收藏、待审回复 |
| `traffic-state.json` | 请求保护（风控）状态 |
| `audit.jsonl` | 网页上的登录、改配置等操作记录 |

## 来源

本项目改造自 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)（作者 ALTERSSSS，MIT 许可）。原项目是 DSH（DeepSeek Harness）插件，本项目把它改为不依赖 DSH 的独立程序。B 站接口、视频理解、风控与额度等逻辑大量移植自原项目。

## 开发

```bash
npm install
npm run fetch-upstream   # 克隆原项目 v0.4.6 到 upstream/，作为移植参考
npm test
npm run build
```

三个包：`packages/bili`（B 站能力，不依赖任何大模型库）、`packages/core`（配置、agent、调度、网页后端、启动命令）、`packages/web`（网页）。

## 许可

MIT，见 [LICENSE](LICENSE)。
