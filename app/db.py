import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def database(*, write=False):
    directory = Path(os.getenv("CHAT_DATA_DIR", "data"))
    directory.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(directory / "chat.sqlite3", timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        if write:
            connection.execute("BEGIN IMMEDIATE")
        yield connection
        connection.commit()
    finally:
        connection.close()


def initialize():
    with database() as connection:
        connection.executescript("""
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                settings TEXT NOT NULL,
                messages TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                generating TEXT
            );
            CREATE TABLE IF NOT EXISTS presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                prompt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            );
        """)
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(chats)")}
        if "archived" not in columns:
            connection.execute("ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        if "preset_snapshot" not in columns:
            connection.execute("ALTER TABLE chats ADD COLUMN preset_snapshot TEXT")
        if "folder_id" not in columns:
            connection.execute("ALTER TABLE chats ADD COLUMN folder_id TEXT")
        if "generated_tokens" not in columns:
            connection.execute("ALTER TABLE chats ADD COLUMN generated_tokens INTEGER")
        if "last_usage" not in columns:
            connection.execute("ALTER TABLE chats ADD COLUMN last_usage TEXT")
        if "last_usage_model" not in columns:
            connection.execute("ALTER TABLE chats ADD COLUMN last_usage_model TEXT")
    # No stream survives a process restart. Repair only the matching answer; older
    # databases can contain empty or partially written message arrays.
    with database(write=True) as connection:
        for row in connection.execute("SELECT * FROM chats WHERE generating IS NOT NULL").fetchall():
            chat = read_chat(row)
            answer = None
            for message in chat["messages"]:
                if message.get("id") == row["generating"]:
                    message["status"] = "interrupted"
                    answer = message
                    break
            finalize_generation(connection, row, chat["messages"], answer)


def read_chat(row):
    return {
        "id": row["id"],
        "title": row["title"],
        "settings": json.loads(row["settings"]),
        "messages": json.loads(row["messages"]),
        "updated_at": row["updated_at"],
        "archived": bool(row["archived"]),
        "preset_snapshot": json.loads(row["preset_snapshot"]) if row["preset_snapshot"] else None,
        "generating": row["generating"],
        "folder_id": row["folder_id"],
        "generated_tokens": row["generated_tokens"],
        "last_usage": json.loads(row["last_usage"]) if row["last_usage"] else None,
        "last_usage_model": row["last_usage_model"],
    }


def save_messages(connection, chat_id, messages, generating=None):
    connection.execute(
        """UPDATE chats SET messages = ?, updated_at = CURRENT_TIMESTAMP, generating = ?
           WHERE id = ?""",
        (json.dumps(messages), generating, chat_id),
    )


def finalize_generation(connection, row, messages, answer):
    usage = answer.get("usage") if answer else None
    if usage:
        completion = usage.get("completion_tokens")
        connection.execute(
            """UPDATE chats SET generated_tokens = CASE WHEN ? IS NULL THEN generated_tokens
               ELSE COALESCE(generated_tokens, 0) + ? END, last_usage = ?, last_usage_model = ?
               WHERE id = ?""",
            (completion, completion, json.dumps(usage), answer.get("actual_model"), row["id"]),
        )
    save_messages(connection, row["id"], messages)
