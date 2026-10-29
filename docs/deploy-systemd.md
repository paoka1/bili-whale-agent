# 用 systemd 长期运行（Linux）

以下假设代码在 `/home/<用户>/bili-whale-agent`，已经 `npm install && npm run build`，用普通用户运行（不要用 root）。

## 1. 先手动跑一次

```bash
cd ~/bili-whale-agent
npm start -- --host 0.0.0.0
```

记下终端里的设置码，在浏览器里设好密码、扫码登录、配好模型，确认能用后按 Ctrl+C 退出。

## 2. 写服务文件

`/etc/systemd/system/bili-whale.service`（把 `<用户>` 换成你的用户名，`node` 路径用 `which node` 查）：

```ini
[Unit]
Description=bili-whale agent
After=network-online.target
Wants=network-online.target

[Service]
User=<用户>
WorkingDirectory=/home/<用户>/bili-whale-agent
ExecStart=/usr/bin/node packages/core/dist/bin.js start --host 0.0.0.0 --port 8787
Restart=on-failure
RestartSec=10
# 退出时等当前这一轮运行结束（程序自己最多等 30 秒）
TimeoutStopSec=45
# 作息按这个时区算；不写就用系统时区
Environment=TZ=Asia/Shanghai

[Install]
WantedBy=multi-user.target
```

## 3. 启动

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bili-whale
journalctl -u bili-whale -f      # 看输出
```

如果还没设过网页密码，设置码会打印在 `journalctl` 的输出里。设置码错 10 次会作废，`sudo systemctl restart bili-whale` 后换一个新的。

## 更新

```bash
cd ~/bili-whale-agent
git pull
npm install
npm run build
sudo systemctl restart bili-whale
```

数据都在 `~/.bili-whale`（或 `--data` 指定的目录），更新代码不会动它。
