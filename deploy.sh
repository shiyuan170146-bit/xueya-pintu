#!/usr/bin/env bash
# ============================================================
# 学涯拼图 + 数独教练 · Linux 云服务器一键部署脚本
# 适用：Ubuntu 22.04 / 24.04（2 核 2G 可跑；MySQL 8 内存偏紧，建议 4G 或加 2G swap）
#
# 用法：
#   1. 把整个 score-system-local 目录上传到服务器（如 /root/app/score-system-local）
#   2. 有域名（推荐，自动 HTTPS）：先在 DNS 加两条 A 记录指向服务器公网 IP，然后
#        cd score-system-local && sudo bash deploy.sh xueya.你的域名.com sudoku.你的域名.com
#      第 1 个域名 = 学涯拼图，第 2 个域名 = 数独教练
#   3. 没有域名：cd score-system-local && sudo bash deploy.sh
#      访问 http://服务器IP/（学涯拼图）与 http://服务器IP/sudoku/（数独教练）
#   4. 云控制台「防火墙」放行 80 / 443 端口（8787 只在服务器内部，不用放行）
#
# 说明：
#   - 数据库密码脚本自动生成，并写回 server/db.local.txt 留档；想固定密码就
#     用 sudo DB_PASS=你的密码 bash deploy.sh
#   - index.html 的 SDK 必须是 assets/cloud-client.js（本机版），换成云端
#     vendor/workbuddy-cloud-sdk.js 版会整页白屏
#   - 数独教练是零外部引用的静态单文件，改版后重新拷进 sudoku/ 目录再跑本脚本即可
# ============================================================
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
SRV="$BASE_DIR/server"
SUDOKU_DIR="$BASE_DIR/sudoku"
DB_NAME=score_db
DB_USER=score_user
DB_PASS="${DB_PASS:-$(openssl rand -hex 12 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
PORT=8787
DOMAIN_PIN="${1:-}"
DOMAIN_SUDOKU="${2:-}"

echo "==> 配置 2G swap（2核2G 机器跑 MySQL 8 更稳；已有则跳过）"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
if ! grep -q '^/swapfile' /etc/fstab 2>/dev/null; then
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

echo "==> 安装运行环境（Node.js 20+、MySQL 8、Caddy）"
apt-get update -y
apt-get install -y curl ca-certificates

# Ubuntu 24.04 的 apt node 是 18（本后端零框架，够用）；22.04 的是 12（太旧，走 NodeSource 装 20）
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  V="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "${V:-0}" -ge 18 ]; then NEED_NODE=0; fi
fi
if [ "$NEED_NODE" = "1" ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  apt-get install -y nodejs npm
fi

apt-get install -y mysql-server

# Caddy：24.04 的 apt 源里有；装不上就挂官方源再试（22.04 需要）
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y caddy || {
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -y
    apt-get install -y caddy
  }
fi

systemctl enable --now mysql

echo "==> 创建数据库与应用账号"
mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS ${DB_NAME} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "==> 导入建库脚本（会重建 score_db，等于清库重置）"
mysql -uroot --default-character-set=utf8mb4 < "$SRV/sql/score_db_mysql.sql"

echo "==> 安装后端依赖"
cd "$SRV"
npm install --omit=dev --no-audit --no-fund

echo "==> 数据库密码写回 server/db.local.txt（留档，勿删）"
echo "$DB_PASS" > "$SRV/db.local.txt"
chmod 600 "$SRV/db.local.txt"

echo "==> 注册系统服务（开机自启 + 崩溃自动拉起）"
cat >/etc/systemd/system/xueya-pintu.service <<UNIT
[Unit]
Description=Xueya Pintu (student academic navigation)
After=network.target mysql.service

[Service]
Type=simple
WorkingDirectory=$SRV
Environment=PORT=$PORT
Environment=MYSQL_HOST=127.0.0.1
Environment=MYSQL_PORT=3306
Environment=MYSQL_USER=$DB_USER
Environment=MYSQL_PASSWORD=$DB_PASS
Environment=MYSQL_DATABASE=$DB_NAME
ExecStart=$(command -v node) index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now xueya-pintu

echo "==> 部署数独教练（纯静态单文件）"
mkdir -p /var/www/sudoku
cp "$SUDOKU_DIR/index.html" /var/www/sudoku/index.html

echo "==> 配置 Caddy 反向代理 + 自动 HTTPS"
if [ -n "$DOMAIN_PIN" ] && [ -n "$DOMAIN_SUDOKU" ]; then
  cat >/etc/caddy/Caddyfile <<CADDY
$DOMAIN_PIN {
    reverse_proxy 127.0.0.1:8787
}

$DOMAIN_SUDOKU {
    root * /var/www/sudoku
    file_server
}
CADDY
  URL_PIN="https://$DOMAIN_PIN/"
  URL_SUDOKU="https://$DOMAIN_SUDOKU/"
else
  cat >/etc/caddy/Caddyfile <<CADDY
:80 {
    handle_path /sudoku/* {
        root * /var/www/sudoku
        file_server
    }
    handle {
        reverse_proxy 127.0.0.1:8787
    }
}
CADDY
  URL_PIN="http://<服务器公网IP>/"
  URL_SUDOKU="http://<服务器公网IP>/sudoku/"
fi

systemctl enable --now caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "==> 部署完成"
echo "    学涯拼图： $URL_PIN"
echo "    数独教练： $URL_SUDOKU"
echo "    服务管理： systemctl status|restart xueya-pintu  /  systemctl status|reload caddy"
echo "    数据库账号： $DB_USER / $DB_PASS（也已写进 server/db.local.txt）"
