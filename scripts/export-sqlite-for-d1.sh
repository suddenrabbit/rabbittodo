#!/usr/bin/env bash
# Export only application data from SQLite to a D1-compatible SQL file.
# Usage: ./scripts/export-sqlite-for-d1.sh /path/to/todo.sqlite ./todo-d1-import.sql
set -euo pipefail

SOURCE_DB="${1:?请提供 SQLite 数据库路径}"
OUTPUT_SQL="${2:?请提供导出 SQL 文件路径}"

{
  echo "PRAGMA defer_foreign_keys = true;"
  sqlite3 "${SOURCE_DB}" '.dump identities tasks' | awk '/^INSERT INTO/'
} > "${OUTPUT_SQL}"

echo "已导出：${OUTPUT_SQL}"
echo "导入前请按 README 的说明核对 SQL 文件。"
