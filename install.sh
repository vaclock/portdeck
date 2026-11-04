#!/usr/bin/env bash
set -euo pipefail

# PortDeck 安装脚本（macOS / Linux）
#
#   bash install.sh                       # 在包目录里执行，装当前版本
#   curl -fsSL <脚本地址> | bash           # 从 npm 拉取最新版安装
#
# 可用环境变量：
#   PORTDECK_VERSION=1.2.0     指定版本（默认 latest）
#   PORTDECK_BIN_DIR=~/.local/bin   命令安装位置
#   PORTDECK_HOME=~/.portdeck  程序安装目录
#   PORTDECK_REGISTRY=https://registry.npmjs.org
#
#   --no-path                  不修改 shell 启动文件（自己配 PATH 时用）
#   --uninstall                卸载（会一并清掉写进启动文件的 PATH 片段）
#
# 卸载：bash install.sh --uninstall

PKG_NAME="portdeck"
VERSION="${PORTDECK_VERSION:-latest}"
APP_DIR="${PORTDECK_HOME:-$HOME/.portdeck}/app"
BIN_DIR="${PORTDECK_BIN_DIR:-$HOME/.local/bin}"
REGISTRY="${PORTDECK_REGISTRY:-https://registry.npmjs.org}"
NO_PATH="${PORTDECK_NO_PATH:-0}"

MARK_BEGIN="# >>> portdeck >>>"
MARK_END="# <<< portdeck <<<"

info() { printf '  %s\n' "$*"; }
fail() { printf '  错误：%s\n' "$*" >&2; exit 1; }

# 当前 shell 对应的启动文件；fish 用另一套语法
rc_file_for_shell() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) printf '%s' "$HOME/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = "Darwin" ]; then printf '%s' "$HOME/.bash_profile"
      else printf '%s' "$HOME/.bashrc"
      fi
      ;;
    fish) printf '%s' "$HOME/.config/fish/config.fish" ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

path_line_for_rc() {
  case "$1" in
    *.fish) printf 'fish_add_path "%s"' "$BIN_DIR" ;;
    *) printf 'export PATH="%s:$PATH"' "$BIN_DIR" ;;
  esac
}

remove_path_block() {
  for file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" \
    "$HOME/.config/fish/config.fish"; do
    [ -f "$file" ] || continue
    grep -qF "$MARK_BEGIN" "$file" || continue
    awk -v begin="$MARK_BEGIN" -v end="$MARK_END" '
      $0 == begin { skip = 1; next }
      $0 == end   { skip = 0; next }
      !skip
    ' "$file" > "$file.portdeck.tmp" && mv "$file.portdeck.tmp" "$file"
    info "已从 $file 移除 PATH 配置"
  done
}

add_path_block() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) info "$BIN_DIR 已在 PATH 中"; return 0 ;;
  esac

  if [ "$NO_PATH" = "1" ]; then
    info "已跳过 PATH 配置，请自行把 $BIN_DIR 加入 PATH"
    return 0
  fi

  local rc shell_line
  rc="$(rc_file_for_shell)"
  shell_line="$(path_line_for_rc "$rc")"

  if [ -f "$rc" ] && grep -qF "$MARK_BEGIN" "$rc"; then
    info "$rc 里已有 portdeck 的 PATH 配置"
    return 0
  fi

  mkdir -p "$(dirname "$rc")"
  {
    printf '\n%s\n' "$MARK_BEGIN"
    printf '%s\n' "$shell_line"
    printf '%s\n' "$MARK_END"
  } >> "$rc" || fail "写入 $rc 失败"

  info "已把 $BIN_DIR 写进 $rc"
  info "当前终端还不会生效，执行 source \"$rc\" 或重开一个终端"
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$APP_DIR" "$BIN_DIR/$PKG_NAME"
  remove_path_block
  info "已卸载 PortDeck（备注仍保留在 ~/.portdeck/notes.json）"
  exit 0
fi

if [ "${1:-}" = "--no-path" ]; then
  NO_PATH=1
fi

command -v node >/dev/null 2>&1 || fail "需要先安装 Node.js 18+：https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node 版本过低（当前 $(node -v)），需要 18 或更高"

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/server.js" ]; then
  VERSION="$(node -p "require('$SCRIPT_DIR/package.json').version")"
  info "从本地目录安装 $PKG_NAME@$VERSION"
  mkdir -p "$TMP_DIR/pkg"
  cp "$SCRIPT_DIR/server.js" "$TMP_DIR/pkg/"
  cp "$SCRIPT_DIR/package.json" "$TMP_DIR/pkg/"
  cp -R "$SCRIPT_DIR/public" "$TMP_DIR/pkg/"
  [ -f "$SCRIPT_DIR/README.md" ] && cp "$SCRIPT_DIR/README.md" "$TMP_DIR/pkg/"
  [ -f "$SCRIPT_DIR/LICENSE" ] && cp "$SCRIPT_DIR/LICENSE" "$TMP_DIR/pkg/"
else
  if [ "$VERSION" = "latest" ]; then
    VERSION="$(curl -fsSL "$REGISTRY/$PKG_NAME/latest" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).version)}catch{process.exit(1)}})')" \
      || fail "无法从 $REGISTRY 获取版本信息"
  fi

  info "下载 $PKG_NAME@$VERSION"
  curl -fsSL "$REGISTRY/$PKG_NAME/-/$PKG_NAME-$VERSION.tgz" -o "$TMP_DIR/pkg.tgz" \
    || fail "下载失败：$REGISTRY/$PKG_NAME/-/$PKG_NAME-$VERSION.tgz"

  mkdir -p "$TMP_DIR/extract"
  tar -xzf "$TMP_DIR/pkg.tgz" -C "$TMP_DIR/extract"
  mv "$TMP_DIR/extract/package" "$TMP_DIR/pkg"
fi

[ -f "$TMP_DIR/pkg/server.js" ] || fail "安装包内容不完整，缺少 server.js"

rm -rf "$APP_DIR"
mkdir -p "$(dirname "$APP_DIR")" "$BIN_DIR"
mv "$TMP_DIR/pkg" "$APP_DIR"
chmod +x "$APP_DIR/server.js"

ln -sf "$APP_DIR/server.js" "$BIN_DIR/$PKG_NAME"

"$BIN_DIR/$PKG_NAME" --version >/dev/null 2>&1 || fail "安装后自检失败，请检查 Node 环境"

if command -v lsof >/dev/null 2>&1; then
  :
elif command -v ss >/dev/null 2>&1; then
  info "未找到 lsof，端口扫描将使用 ss"
else
  info "提示：需要 lsof 或 ss 才能扫描端口（Debian/Ubuntu：sudo apt install lsof）"
fi

info "已安装 $PKG_NAME@$VERSION → $APP_DIR"

add_path_block

info "用法：portdeck（浏览器看板） / portdeck --list / portdeck --kill 3000"
