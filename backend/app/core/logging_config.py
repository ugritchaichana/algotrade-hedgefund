"""Structured JSON logging — stdlib only, no new deps.

Adds a JSON-line sink at logs/algotrade.jsonl alongside the existing stdout logger.
Each line: timestamp, level, logger, message, exc_info (if any), and any extra fields
the caller passed via `log.info(msg, extra={"k": "v"})`.

Designed to be additive: the existing stdout handler keeps working unchanged. Call
`configure_json_logging()` once at startup. Safe to call multiple times.
"""

import json
import logging
import logging.handlers
import os
import datetime

_RESERVED_LOG_ATTRS = {
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "asctime", "message", "taskName",
}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts": datetime.datetime.fromtimestamp(record.created, tz=datetime.timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)
        # Pass-through any extra fields the caller passed via `extra=` kwarg
        for key, value in record.__dict__.items():
            if key in _RESERVED_LOG_ATTRS:
                continue
            try:
                json.dumps(value)
                payload[key] = value
            except (TypeError, ValueError):
                payload[key] = repr(value)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_json_logging(log_dir: str = "logs", filename: str = "algotrade.jsonl",
                            max_bytes: int = 25 * 1024 * 1024, backup_count: int = 7) -> None:
    """Attach a rotating JSON file handler to the root logger. Idempotent."""
    os.makedirs(log_dir, exist_ok=True)
    path = os.path.join(log_dir, filename)

    root = logging.getLogger()
    # Skip if already attached (idempotency on hot reload)
    for h in root.handlers:
        if getattr(h, "_algotrade_json_sink", False):
            return

    handler = logging.handlers.RotatingFileHandler(
        path, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8"
    )
    handler.setLevel(logging.INFO)
    handler.setFormatter(JsonFormatter())
    handler._algotrade_json_sink = True  # marker for idempotency
    root.addHandler(handler)
    logging.getLogger(__name__).info("JSON log sink attached at %s", path)
