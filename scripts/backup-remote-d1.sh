#!/usr/bin/env bash
# Backup the remote (production) D1 database as a SQL dump.
# Also tries to record the Time Travel rollback info next to the dump.
# Usage: ./scripts/backup-remote-d1.sh [输出目录，默认 ./backups]
set -euo pipefail

DATABASE_NAME="rabbittodo"
OUTPUT_DIR="${1:-backups}"
TIMESTAMP="$(TZ=Asia/Shanghai date +%Y%m%d.%H%M%S)"
BACKUP_DIR="${OUTPUT_DIR}/${TIMESTAMP}"
DUMP_FILE="${BACKUP_DIR}/rabbittodo-${TIMESTAMP}.sql"

mkdir -p "${BACKUP_DIR}"

echo "开始备份远程 D1 数据库：${DATABASE_NAME}"
pnpm exec wrangler d1 export "${DATABASE_NAME}" --remote --output "${DUMP_FILE}" --skip-confirmation

if [[ ! -s "${DUMP_FILE}" ]]; then
  echo "备份失败：导出文件为空" >&2
  exit 1
fi

# 记录 Time Travel bookmark，便于需要回退时对照；失败不影响 SQL 备份。
if ! pnpm exec wrangler d1 time-travel info "${DATABASE_NAME}" > "${BACKUP_DIR}/time-travel-info.txt" 2>&1; then
  echo "提示：未能记录 Time Travel 信息（不影响 SQL 备份）" >&2
fi

cat > "${BACKUP_DIR}/backup-meta.txt" <<EOF
备份时间：$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S %Z')
数据库：${DATABASE_NAME}（远程 D1）
导出文件：${DUMP_FILE}
EOF

echo "备份完成：${BACKUP_DIR}"
echo "  - 数据导出：${DUMP_FILE}"
echo "  - 回退参考：${BACKUP_DIR}/time-travel-info.txt（如已记录）"
echo "Time Travel 回退前请按 README 确认 bookmark，禁止直接用导出文件覆盖生产库。"
