import asyncio
import json
import math
import os
import shutil
import sqlite3
import tempfile
import time
from contextlib import asynccontextmanager, closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .db import database, finalize_generation, initialize, read_chat, save_messages


class Settings(BaseModel):
    model: str = ""
    think: bool = False
    system_prompt: str = ""
    max_tokens: int | None = Field(default=None, ge=1)
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)


class ChatCreate(BaseModel):
    settings: Settings | None = None
    preset_id: str | None = None
    folder_id: str | None = None


class ChatUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    settings: Settings | None = None
    folder_id: str | None = None


class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value):
        if not (name := value.strip()):
            raise ValueError("Enter a folder name.")
        return name


class Preset(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    prompt: str

    @field_validator("name")
    @classmethod
    def strip_name(cls, value):
        if not (name := value.strip()):
            raise ValueError("Enter a preset name.")
        return name


class Generation(BaseModel):
    action: Literal["append", "edit", "regenerate"] = "append"
    content: str = ""
    message_id: str | None = None
    keep_original: bool = True


@asynccontextmanager
async def lifespan(app):
    initialize()
    base_url = os.getenv("FASTFLOWLM_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
    if not base_url.endswith("/v1"):
        base_url += "/v1"
    async with httpx.AsyncClient(
        base_url=base_url, timeout=httpx.Timeout(300, connect=5), trust_env=False
    ) as client:
        app.state.flm = client
        app.state.generations = {}
        yield


app = FastAPI(lifespan=lifespan)


def chat_row(connection, chat_id):
    row = connection.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Chat not found.")
    return row


def require_idle(row):
    if row["generating"]:
        raise HTTPException(409, "This chat is still generating a reply.")


@app.get("/api/health")
def health():
    return {"status": "ok"}


class TemporaryBackupResponse(FileResponse):
    async def __call__(self, scope, receive, send):
        try:
            # A pathsend extension may hand a filename off for later use, after
            # this response returns. Stream the file so cleanup is safe here.
            extensions = dict(scope.get("extensions", {}))
            extensions.pop("http.response.pathsend", None)
            await super().__call__({**scope, "extensions": extensions}, receive, send)
        finally:
            shutil.rmtree(Path(self.path).parent, ignore_errors=True)


@app.get("/api/backup")
def download_backup():
    source_path = (Path(os.getenv("CHAT_DATA_DIR", "data")) / "chat.sqlite3").resolve()
    directory = Path(tempfile.mkdtemp(prefix="local-chat-backup-"))
    temporary = directory / "backup.sqlite3"
    try:
        # Read-only opening avoids creating or changing the live database; SQLite's
        # online backup API includes committed pages still held in its WAL.
        with closing(sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True, timeout=30)) as source:
            with closing(sqlite3.connect(temporary, timeout=30)) as destination:
                source.backup(destination, pages=256, sleep=0.05)
                destination.execute("PRAGMA journal_mode=DELETE")
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return TemporaryBackupResponse(
            temporary,
            media_type="application/vnd.sqlite3",
            filename=f"local-chat-backup-{timestamp}.sqlite3",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise


@app.get("/api/models")
async def models():
    try:
        response = await app.state.flm.get("models", timeout=10)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(502, "Could not fetch models from FastFlowLM.") from error


def require_folder(connection, folder_id):
    if folder_id is not None and connection.execute(
        "SELECT 1 FROM folders WHERE id = ?", (folder_id,)
    ).fetchone() is None:
        raise HTTPException(404, "Folder not found.")


@app.get("/api/folders")
def list_folders():
    with database() as connection:
        return [dict(row) for row in connection.execute(
            "SELECT id, name FROM folders ORDER BY name COLLATE NOCASE, id"
        )]


@app.post("/api/folders", status_code=201)
def create_folder(body: FolderCreate):
    folder = {"id": uuid4().hex, "name": body.name}
    with database(write=True) as connection:
        connection.execute("INSERT INTO folders (id, name) VALUES (:id, :name)", folder)
    return folder


@app.delete("/api/folders/{folder_id}", status_code=204)
def delete_folder(folder_id: str):
    with database(write=True) as connection:
        require_folder(connection, folder_id)
        connection.execute("UPDATE chats SET folder_id = NULL WHERE folder_id = ?", (folder_id,))
        connection.execute("DELETE FROM folders WHERE id = ?", (folder_id,))


@app.get("/api/chats")
def list_chats(archived: bool = False, folder_id: str | None = None, unfiled: bool = False):
    if folder_id is not None and unfiled:
        raise HTTPException(422, "Choose a folder or unfiled, not both.")
    with database() as connection:
        if folder_id is not None:
            require_folder(connection, folder_id)
        condition = " AND folder_id IS NULL" if unfiled else " AND folder_id = ?" if folder_id is not None else ""
        params = (int(archived), folder_id) if folder_id is not None else (int(archived),)
        return [
            {**dict(row), "archived": bool(row["archived"])}
            for row in connection.execute(
                "SELECT id, title, updated_at, archived, folder_id FROM chats WHERE archived = ?"
                + condition + " ORDER BY updated_at DESC, rowid DESC", params
            )
        ]


@app.post("/api/chats", status_code=201)
def create_chat(body: ChatCreate):
    chat_id = uuid4().hex
    with database(write=True) as connection:
        require_folder(connection, body.folder_id)
        defaults = connection.execute("SELECT value FROM app_settings WHERE key = 'defaults'").fetchone()
        settings = (body.settings or (Settings.model_validate_json(defaults["value"])
                    if defaults else Settings())).model_dump()
        if body.preset_id is not None:
            preset = connection.execute(
                "SELECT id, name, prompt FROM presets WHERE id = ?", (body.preset_id,)
            ).fetchone()
            if preset is None:
                raise HTTPException(404, "Preset not found.")
            settings["system_prompt"] = preset["prompt"]
        snapshot = json.dumps(dict(preset)) if body.preset_id is not None else None
        connection.execute(
            "INSERT INTO chats (id, title, settings, preset_snapshot, folder_id) VALUES (?, ?, ?, ?, ?)",
            (chat_id, "New chat", json.dumps(settings), snapshot, body.folder_id),
        )
        return read_chat(chat_row(connection, chat_id))


@app.get("/api/chats/{chat_id}")
def get_chat(chat_id: str):
    with database() as connection:
        return read_chat(chat_row(connection, chat_id))


@app.patch("/api/chats/{chat_id}")
def update_chat(chat_id: str, body: ChatUpdate):
    with database(write=True) as connection:
        row = chat_row(connection, chat_id)
        require_idle(row)
        folder_id = body.folder_id if "folder_id" in body.model_fields_set else row["folder_id"]
        require_folder(connection, folder_id)
        title = row["title"] if body.title is None else body.title.strip()
        if not title:
            raise HTTPException(422, "Enter a chat title.")
        settings = row["settings"] if body.settings is None else body.settings.model_dump_json()
        connection.execute(
            """UPDATE chats SET title = ?, settings = ?, folder_id = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (title, settings, folder_id, chat_id),
        )
        return read_chat(chat_row(connection, chat_id))


@app.delete("/api/chats/{chat_id}", status_code=204)
def delete_chat(chat_id: str):
    with database(write=True) as connection:
        require_idle(chat_row(connection, chat_id))
        connection.execute("DELETE FROM chats WHERE id = ?", (chat_id,))


def set_archived(chat_id: str, archived: bool):
    with database(write=True) as connection:
        require_idle(chat_row(connection, chat_id))
        connection.execute(
            "UPDATE chats SET archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (int(archived), chat_id),
        )
        return read_chat(chat_row(connection, chat_id))


@app.post("/api/chats/{chat_id}/archive")
def archive_chat(chat_id: str):
    return set_archived(chat_id, True)


@app.post("/api/chats/{chat_id}/restore")
def restore_chat(chat_id: str):
    return set_archived(chat_id, False)


@app.delete("/api/chats/{chat_id}/turns/{message_id}")
def delete_turn(chat_id: str, message_id: str):
    with database(write=True) as connection:
        row = chat_row(connection, chat_id)
        require_idle(row)
        messages = read_chat(row)["messages"]
        index = next((i for i, item in enumerate(messages)
                      if item.get("id") == message_id and item.get("role") == "user"), None)
        if index is None:
            raise HTTPException(404, "User message not found.")
        end = index + 1
        if end < len(messages) and messages[end].get("role") == "assistant":
            end += 1
        del messages[index:end]
        save_messages(connection, chat_id, messages)
        return read_chat(chat_row(connection, chat_id))


@app.get("/api/settings")
def get_settings():
    with database() as connection:
        row = connection.execute("SELECT value FROM app_settings WHERE key = 'defaults'").fetchone()
        return Settings.model_validate_json(row["value"]).model_dump() if row else Settings().model_dump()


@app.put("/api/settings")
def set_settings(settings: Settings):
    with database(write=True) as connection:
        connection.execute(
            "INSERT INTO app_settings(key, value) VALUES ('defaults', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (settings.model_dump_json(),)
        )
    return settings.model_dump()


@app.get("/api/presets")
def list_presets():
    with database() as connection:
        return [dict(row) for row in connection.execute(
            "SELECT * FROM presets ORDER BY name COLLATE NOCASE, id"
        )]


@app.post("/api/presets", status_code=201)
def create_preset(body: Preset):
    preset = {"id": uuid4().hex, **body.model_dump()}
    with database(write=True) as connection:
        connection.execute("INSERT INTO presets VALUES (:id, :name, :prompt)", preset)
    return preset


@app.put("/api/presets/{preset_id}")
def update_preset(preset_id: str, body: Preset):
    preset = {"id": preset_id, **body.model_dump()}
    with database(write=True) as connection:
        result = connection.execute(
            "UPDATE presets SET name = :name, prompt = :prompt WHERE id = :id", preset
        )
        if result.rowcount == 0:
            raise HTTPException(404, "Preset not found.")
    return preset


@app.delete("/api/presets/{preset_id}", status_code=204)
def delete_preset(preset_id: str):
    with database(write=True) as connection:
        if not connection.execute("DELETE FROM presets WHERE id = ?", (preset_id,)).rowcount:
            raise HTTPException(404, "Preset not found.")


def begin_generation(chat_id, body):
    with database(write=True) as connection:
        row = chat_row(connection, chat_id)
        require_idle(row)
        if row["archived"]:
            raise HTTPException(409, "Restore this chat before generating a reply.")
        chat = read_chat(row)
        settings = Settings.model_validate(chat["settings"])
        if not settings.model:
            raise HTTPException(422, "Choose a model before sending a message.")
        messages = chat["messages"]
        content = body.content.strip()
        if body.action != "append":
            index = next(
                (i for i, item in enumerate(messages)
                 if item["id"] == body.message_id and item["role"] == "user"),
                None,
            )
            if index is None:
                raise HTTPException(404, "User message not found.")
            if body.action == "regenerate":
                content = messages[index]["content"]
            messages = messages[:index]
        if not content:
            raise HTTPException(422, "Enter a message.")

        title = chat["title"]
        if body.action != "append" and body.keep_original:
            chat_id = uuid4().hex
            title = f"{title[:191]} (branch)"
            connection.execute(
                "INSERT INTO chats (id, title, settings, preset_snapshot, folder_id) VALUES (?, ?, ?, ?, ?)",
                (chat_id, title, row["settings"], row["preset_snapshot"], row["folder_id"]),
            )
        elif not messages and title == "New chat":
            title = " ".join(content.split())[:72]
            connection.execute("UPDATE chats SET title = ? WHERE id = ?", (title, chat_id))

        messages.append({"id": uuid4().hex, "role": "user", "content": content})
        context = [{"role": item["role"], "content": item["content"]} for item in messages
                   if item["content"]]
        if settings.system_prompt.strip():
            context.insert(0, {"role": "system", "content": settings.system_prompt})
        answer = {
            "id": uuid4().hex, "role": "assistant", "model": settings.model,
            "content": "", "reasoning": "", "status": "streaming",
            "settings": settings.model_dump(),
        }
        messages.append(answer)
        save_messages(connection, chat_id, messages, generating=answer["id"])

        payload = settings.model_dump(exclude={"system_prompt"}, exclude_none=True)
        payload.update(messages=context, stream=True, stream_options={"include_usage": True})
        return chat_id, title, messages, answer, payload


def event(kind, **data):
    return f"data: {json.dumps({'type': kind, **data})}\n\n"


async def upstream_events(response):
    lines = []
    async for line in response.aiter_lines():
        if line.startswith("data:"):
            lines.append(line[5:].lstrip(" "))
        elif not line and lines:
            yield "\n".join(lines)
            lines.clear()
    if lines:
        yield "\n".join(lines)


def checkpoint(chat_id, messages, answer, active):
    with database(write=True) as connection:
        row = chat_row(connection, chat_id)
        if row["generating"] == answer["id"]:
            if active:
                save_messages(connection, chat_id, messages, answer["id"])
            else:
                finalize_generation(connection, row, messages, answer)


def normalize_usage(value):
    if not isinstance(value, dict):
        return None
    result = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens", "active_kv_tokens", "max_kv_token_capacity"):
        number = value.get(key)
        if type(number) is int and number >= 0:
            result[key] = number
    details = value.get("prompt_tokens_details")
    if isinstance(details, dict) and type(details.get("cached_tokens")) is int and details["cached_tokens"] >= 0:
        result["cached_tokens"] = details["cached_tokens"]
    occupancy = value.get("kv_token_occupancy_rate_percentage")
    if type(occupancy) in (int, float) and math.isfinite(occupancy) and occupancy >= 0:
        result["kv_token_occupancy_rate_percentage"] = occupancy
    return result or None


@asynccontextmanager
async def upstream_completion(payload):
    async with app.state.flm.stream("POST", "chat/completions", json=payload) as response:
        retry = False
        if response.status_code == 400:
            body = (await response.aread()).decode("utf-8", errors="replace").lower()
            retry = ("stream_options" in body or "include_usage" in body) and any(
                phrase in body for phrase in ("unsupported", "not supported", "unknown", "unrecognized", "unexpected", "extra inputs")
            )
        if not retry:
            yield response
            return
    compatible_payload = {key: value for key, value in payload.items() if key != "stream_options"}
    async with app.state.flm.stream("POST", "chat/completions", json=compatible_payload) as response:
        yield response


@app.post("/api/chats/{chat_id}/generate")
async def generate(chat_id: str, body: Generation, request: Request):
    chat_id, title, messages, answer, payload = begin_generation(chat_id, body)
    generation = {"task": None, "cancelled": False}
    app.state.generations[chat_id] = generation

    async def stream():
        status = "interrupted"
        last_save = time.monotonic()
        try:
            generation["task"] = asyncio.current_task()
            if generation["cancelled"]:
                raise asyncio.CancelledError
            yield event("start", chat_id=chat_id, title=title, messages=messages)
            async with upstream_completion(payload) as response:
                if response.is_error:
                    raise ValueError(f"FastFlowLM returned HTTP {response.status_code}.")
                if "text/event-stream" not in response.headers.get("content-type", ""):
                    raise ValueError("FastFlowLM did not return an event stream.")
                async for data in upstream_events(response):
                    if await request.is_disconnected():
                        return
                    if data == "[DONE]":
                        if not answer["content"] and not answer["reasoning"]:
                            raise ValueError("FastFlowLM returned an empty reply.")
                        status = "complete"
                        break
                    chunk = json.loads(data)
                    if chunk.get("error"):
                        error = chunk["error"]
                        raise ValueError(str(error.get("message", error) if isinstance(error, dict) else error))
                    if isinstance(chunk.get("model"), str) and chunk["model"]:
                        answer["actual_model"] = chunk["model"]
                        answer["model"] = chunk["model"]
                    usage = normalize_usage(chunk.get("usage"))
                    if usage is not None:
                        answer["usage"] = usage
                        checkpoint(chat_id, messages, answer, active=True)
                        last_save = time.monotonic()
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    model = chunk.get("model") or answer["model"]
                    content = delta.get("content") or ""
                    reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
                    finish_reason = choices[0].get("finish_reason")
                    if finish_reason:
                        answer["finish_reason"] = finish_reason
                    answer["model"] = model
                    answer["content"] += content
                    answer["reasoning"] += reasoning
                    if time.monotonic() - last_save >= 1:
                        checkpoint(chat_id, messages, answer, active=True)
                        last_save = time.monotonic()
                    if content or reasoning:
                        yield event("delta", model=model, content=content, reasoning=reasoning)
                if status != "complete":
                    raise ValueError("FastFlowLM closed the stream before completing the reply.")
        except asyncio.CancelledError:
            if generation["cancelled"]:
                status = "cancelled"
            else:
                raise
        except (httpx.HTTPError, ValueError, TypeError, AttributeError) as error:
            status = "error"
            answer["error"] = (
                "The connection to FastFlowLM failed." if isinstance(error, httpx.HTTPError)
                else str(error)
            )
        finally:
            answer["status"] = status
            checkpoint(chat_id, messages, answer, active=False)
            app.state.generations.pop(chat_id, None)
        yield event("done", message=answer)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )


@app.post("/api/chats/{chat_id}/cancel", status_code=202)
async def cancel_generation(chat_id: str):
    with database() as connection:
        row = chat_row(connection, chat_id)
        if not row["generating"]:
            raise HTTPException(409, "This chat is not generating a reply.")
    generation = app.state.generations.get(chat_id)
    if generation is None:
        raise HTTPException(409, "The generation is not running in this process.")
    generation["cancelled"] = True
    if generation["task"] is not None:
        generation["task"].cancel()
    return {"status": "cancelling"}


dist = Path(__file__).resolve().parent.parent / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="ui")
