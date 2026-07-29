#!/usr/bin/env bash
# Export application data from the legacy SQLite database to D1-compatible SQL.
# Supports both the old SQLite schema (without details/status) and the current schema.
# Usage: ./scripts/export-sqlite-for-d1.sh /path/to/todo.sqlite ./todo-d1-import.sql
set -euo pipefail

SOURCE_DB="${1:?请提供 SQLite 数据库路径}"
OUTPUT_SQL="${2:?请提供导出 SQL 文件路径}"

if [[ ! -f "${SOURCE_DB}" ]]; then
  echo "找不到 SQLite 数据库：${SOURCE_DB}" >&2
  exit 1
fi

has_column() {
  sqlite3 "${SOURCE_DB}" "SELECT EXISTS(SELECT 1 FROM pragma_table_info('tasks') WHERE name = '$1');"
}

if [[ "$(has_column details)" == "1" ]]; then
  details_value="quote(COALESCE(details, ''))"
else
  details_value="quote('')"
fi

if [[ "$(has_column status)" == "1" ]]; then
  status_value="quote(CASE WHEN status IN ('none', 'in_progress', 'paused') THEN status ELSE 'none' END)"
else
  status_value="quote('none')"
fi

{
  echo "PRAGMA defer_foreign_keys = true;"
  sqlite3 -noheader "${SOURCE_DB}" "
    SELECT 'INSERT INTO identities (code, created_at) VALUES (' ||
      quote(code) || ', ' || quote(created_at) || ');'
    FROM identities
    ORDER BY code;
  "
  sqlite3 -noheader "${SOURCE_DB}" "
    SELECT 'INSERT INTO tasks (id, identity_code, title, color, tags, details, due_date, completed, completed_at, position, created_at, updated_at, status) VALUES (' ||
      quote(id) || ', ' ||
      quote(identity_code) || ', ' ||
      quote(title) || ', ' ||
      quote(color) || ', ' ||
      quote(tags) || ', ' ||
      ${details_value} || ', ' ||
      quote(due_date) || ', ' ||
      quote(completed) || ', ' ||
      quote(completed_at) || ', ' ||
      quote(position) || ', ' ||
      quote(created_at) || ', ' ||
      quote(updated_at) || ', ' ||
      ${status_value} || ');'
    FROM tasks
    ORDER BY id;
  "
} > "${OUTPUT_SQL}"

echo "已导出：${OUTPUT_SQL}"
echo "旧 SQLite 中缺少的 details/status 字段会分别导入为空字符串和 none。"
echo "导入前请按 README 的说明核对 SQL 文件。"
