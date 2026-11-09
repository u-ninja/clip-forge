"""Structured JSON logs on stdout, matching the API's pino output shape."""

import json
import logging


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "time": int(record.created * 1000),
            "level": record.levelname.lower(),
            "service": "worker",
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            entry["err"] = self.formatException(record.exc_info)
        return json.dumps(entry)


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=level, handlers=[handler], force=True)
