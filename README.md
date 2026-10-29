# bili-whale-agent

> 开发中，尚不可用。

让一个 AI 用自己的 B 站小号「住在 B 站里」：按作息自己醒来、刷视频、看懂视频、写日记，把值得看的分享给你，回复评论和私信。

一个独立运行的程序：自带 agent（填任意 OpenAI 兼容接口的 base url / model / key 即可），网页里完成配置、查看她的活动。

## 来源

本项目改造自 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)（作者 ALTERSSSS，MIT 许可）。原项目是 DSH（DeepSeek Harness）插件，本项目把它改为不依赖 DSH 的独立程序。B 站接口、视频理解、风控与额度等逻辑大量移植自原项目。

## 开发

```bash
npm install
npm run fetch-upstream   # 克隆原项目 v0.4.6 到 upstream/，作为移植参考
npm test
npm run build
```

## 许可

MIT，见 [LICENSE](LICENSE)。
