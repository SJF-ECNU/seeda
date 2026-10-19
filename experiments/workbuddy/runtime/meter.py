"""Independent, bounded model transport accounting for the experiment.

No credentials or model request/response text are written to the JSONL ledger.
Usage is supplier-reported; missing fields remain unknown. start/register return
only loopback URLs. Stage URLs are capabilities and must not appear in reports.
"""
from __future__ import annotations

import copy
import http.client
import json
import math
import secrets
import threading
import traceback
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Meter:
    def __init__(self, upstream_url, api_key, model, max_attempts=None,
                 max_tokens=None, deadline=None, log_path=None,
                 upstream_timeout=120):
        self.upstream_url = upstream_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.max_attempts = max_attempts
        self.max_tokens = max_tokens
        self.deadline = deadline
        self.upstream_timeout = upstream_timeout
        self.lock = threading.RLock()
        self.stages = {}
        self.tokens = {}
        self.records = []
        self.stop_reason = None
        self.closed = threading.Event()
        self.server = None
        self.responses = set()
        self.opener = urllib.request.build_opener(_NoRedirect())
        self.log = None
        if log_path:
            path = Path(log_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            self.log = path.open("a", buffering=1)

    def _event(self, event):
        # Every caller supplies metadata only. Never accept arbitrary exceptions.
        with self.lock:
            if self.log:
                self.log.write(json.dumps({"at": time.time(), **event}) + "\n")
                self.log.flush()

    def start(self):
        meter = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_POST(self):
                meter._handle(self)

            def do_GET(self):
                meter._recovery(self)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler, bind_and_activate=False)
        self.server.request_queue_size = 64
        self.server.server_bind()
        self.server.server_activate()
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.heartbeat = threading.Thread(target=self._heartbeat, daemon=True)
        self.heartbeat.start()
        return self

    def register(self, stage_id, max_attempts, deadline, category):
        with self.lock:
            if not self.server or self.closed.is_set():
                raise RuntimeError("meter_not_running")
            if stage_id in self.stages:
                raise ValueError("duplicate_stage")
            token = secrets.token_urlsafe(32)
            self.tokens[token] = stage_id
            self.stages[stage_id] = {
                "stage_id": stage_id, "category": category,
                "max_attempts": max_attempts, "deadline": deadline,
                "attempts": 0, "rejected": 0, "active": 0, "closed": False,
            }
            return f"http://127.0.0.1:{self.server.server_port}/{token}/v1"

    def _heartbeat(self):
        while not self.closed.wait(2):
            self._event({"event": "heartbeat", **self.snapshot()})

    @staticmethod
    def _usage(raw):
        if not isinstance(raw, dict):
            return None
        def integer(value):
            return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
        inp = integer(raw.get("prompt_tokens"))
        out = integer(raw.get("completion_tokens"))
        if inp is None or out is None:
            return None
        details = raw.get("prompt_tokens_details")
        details = details if isinstance(details, dict) else {}
        hit = integer(raw.get("prompt_cache_hit_tokens", details.get("cached_tokens")))
        miss = integer(raw.get("prompt_cache_miss_tokens"))
        return {"input_tokens": inp, "output_tokens": out,
                "total_tokens": inp + out, "cache_hit_tokens": hit,
                "cache_miss_tokens": miss}

    def snapshot(self):
        with self.lock:
            finished = [r for r in self.records if r["status"] != "in_flight"]
            usage = [r["usage"] for r in finished if r.get("usage") is not None]
            def total(field):
                return sum(u[field] for u in usage if u[field] is not None)
            return copy.deepcopy({
                "attempts": len(self.records), "completed": len(finished),
                "in_flight": len(self.records) - len(finished),
                "failed_attempts": sum(r["status"] != "success" for r in finished),
                "missing_usage": sum(r.get("usage") is None for r in finished),
                "usage_complete": len(finished) == len(self.records) and all(r.get("usage") is not None for r in finished),
                "usage": {name: total(name) for name in (
                    "input_tokens", "output_tokens", "total_tokens",
                    "cache_hit_tokens", "cache_miss_tokens")},
                "cache_hit_unknown_requests": sum(u["cache_hit_tokens"] is None for u in usage),
                "cache_miss_unknown_requests": sum(u["cache_miss_tokens"] is None for u in usage),
                "stop_reason": self.stop_reason, "stages": self.stages,
            })

    @staticmethod
    def _inference_parameters(body):
        """Log typed inference metadata only; never arbitrary request text."""
        parameters = {}
        for name in ("temperature", "top_p", "top_k", "seed", "max_tokens",
                     "max_completion_tokens", "frequency_penalty", "presence_penalty", "n"):
            value = body.get(name)
            if not isinstance(value, bool) and (isinstance(value, int) or isinstance(value, float) and math.isfinite(value)):
                parameters[name] = value
        if isinstance(body.get("enable_thinking"), bool):
            parameters["enable_thinking"] = body["enable_thinking"]
        if body.get("reasoning_effort") in ("none", "minimal", "low", "medium", "high", "xhigh", "max"):
            parameters["reasoning_effort"] = body["reasoning_effort"]
        thinking = body.get("thinking")
        if isinstance(thinking, dict):
            safe = {}
            if thinking.get("type") in ("enabled", "disabled", "adaptive"):
                safe["type"] = thinking["type"]
            budget = thinking.get("budget_tokens")
            if isinstance(budget, int) and not isinstance(budget, bool):
                safe["budget_tokens"] = budget
            if safe:
                parameters["thinking"] = safe
        return parameters

    def _admit(self, stage_id, inference_parameters=None):
        with self.lock:
            stage = self.stages[stage_id]
            now = time.time()
            reason = self.stop_reason
            if reason:
                pass
            elif self.closed.is_set():
                reason = "meter_closed"
            elif stage.get("closed"):
                reason = "stage_closed"
            elif self.deadline is not None and now >= self.deadline:
                reason = "global_deadline"
                self.stop_reason = reason
            elif self.max_attempts is not None and len(self.records) >= self.max_attempts:
                reason = "global_attempt_budget"
                self.stop_reason = reason
            elif self.max_tokens is not None and self.snapshot()["usage"]["total_tokens"] >= self.max_tokens:
                reason = "global_token_budget"
                self.stop_reason = reason
            elif stage["deadline"] is not None and now >= stage["deadline"]:
                reason = reason or "stage_deadline"
            elif stage["max_attempts"] is not None and stage["attempts"] >= stage["max_attempts"]:
                reason = reason or "stage_attempt_budget"
            if reason:
                stage["rejected"] += 1
                self._event({"event": "rejected", "stage_id": stage_id, "reason": reason})
                return None, reason
            record = {"attempt_id": len(self.records) + 1, "stage_id": stage_id,
                      "category": stage["category"], "model": self.model,
                      "started_at": now, "status": "in_flight", "usage": None,
                      "inference_parameters": copy.deepcopy(inference_parameters or {})}
            self.records.append(record)
            stage["attempts"] += 1
            stage["active"] += 1
            self._event({"event": "attempt_started", **record})
            return record, None

    def recovery_status(self, stage_id):
        """Read the original allowance without admitting or resetting a call."""
        with self.lock:
            stage = self.stages[stage_id]
            snapshot = self.snapshot()
            now = time.time()
            reason = self.stop_reason
            if not reason:
                if self.closed.is_set(): reason = "meter_closed"
                elif stage.get("closed"): reason = "stage_closed"
                elif snapshot["in_flight"]: reason = "usage_in_flight"
                elif snapshot["missing_usage"]: reason = "missing_usage"
                elif self.deadline is not None and now >= self.deadline: reason = "global_deadline"
                elif stage["deadline"] is not None and now >= stage["deadline"]: reason = "stage_deadline"
                elif self.max_attempts is not None and len(self.records) >= self.max_attempts: reason = "global_attempt_budget"
                elif stage["max_attempts"] is not None and stage["attempts"] >= stage["max_attempts"]: reason = "stage_attempt_budget"
                elif self.max_tokens is not None and snapshot["usage"]["total_tokens"] >= self.max_tokens: reason = "global_token_budget"
            return {"allowed": reason is None, "reason": reason,
                    "remaining": {
                        "attempts": min((max(0, cap - used) for cap, used in [(self.max_attempts, len(self.records)), (stage["max_attempts"], stage["attempts"])] if cap is not None), default=None),
                        "tokens": max(0, self.max_tokens - snapshot["usage"]["total_tokens"]) if self.max_tokens is not None and snapshot["usage_complete"] else None,
                        "seconds": min((max(0, cap - now) for cap in [self.deadline, stage["deadline"]] if cap is not None), default=None),
                    }}

    def _recovery(self, handler):
        path = handler.path.split("?")[0].strip("/").split("/")
        with self.lock:
            stage_id = self.tokens.get(path[0]) if len(path) == 3 and path[1:] == ["v1", "recovery"] else None
        if not stage_id:
            self._reject(handler, 404, "unknown_stage_or_endpoint")
            return
        payload = json.dumps(self.recovery_status(stage_id)).encode()
        try:
            handler.send_response(200)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(payload)))
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        handler.close_connection = True

    def _finish(self, record, status, usage, http_status=None):
        with self.lock:
            record.update(status=status, usage=usage, http_status=http_status,
                          finished_at=time.time(), duration_seconds=time.time() - record["started_at"])
            self.stages[record["stage_id"]]["active"] -= 1
            if status != "success":
                self.stop_reason = self.stop_reason or status
            elif usage is None:
                self.stop_reason = self.stop_reason or "missing_usage"
            elif self.max_tokens is not None and self.snapshot()["usage"]["total_tokens"] >= self.max_tokens:
                self.stop_reason = self.stop_reason or "global_token_budget"
            self._event({"event": "attempt_finished", **record})

    @staticmethod
    def _reject(handler, status, reason):
        payload = json.dumps({"error": {"type": "experiment_transport", "code": reason,
                                        "message": reason}}).encode()
        try:
            handler.send_response(status)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(payload)))
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        handler.close_connection = True

    def _handle(self, handler):
        path = handler.path.split("?")[0].strip("/").split("/")
        with self.lock:
            stage_id = None
            # Full route is /<opaque>/v1/chat/completions.
            if len(path) == 4 and path[1:] == ["v1", "chat", "completions"]:
                stage_id = self.tokens.get(path[0])
        if not stage_id:
            self._reject(handler, 404, "unknown_stage_or_endpoint")
            return
        try:
            handler.connection.settimeout(10)
            length = int(handler.headers.get("Content-Length", "0"))
            if not 0 < length <= 32 * 1024 * 1024:
                raise ValueError()
            body = json.loads(handler.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError()
        except (ValueError, OSError):
            self._reject(handler, 400, "invalid_request")
            return
        body["model"] = self.model
        streaming = body.get("stream") is True
        body["stream"] = streaming
        if streaming:
            options = body.get("stream_options")
            body["stream_options"] = {**(options if isinstance(options, dict) else {}), "include_usage": True}
        record, reason = self._admit(stage_id, self._inference_parameters(body))
        if reason:
            self._reject(handler, 409, reason)
            return
        response = None
        operation = "upstream_connect"
        received_bytes = forwarded_bytes = 0
        caught_error = None
        started_response = False
        usage = None
        status = "network_error"
        http_status = None
        buffer = b""
        done = False
        payload_error = False
        try:
            request = urllib.request.Request(
                self.upstream_url + "/chat/completions",
                data=json.dumps(body).encode(),
                headers={"Authorization": "Bearer " + self.api_key,
                         "Content-Type": "application/json", "Accept": "text/event-stream" if streaming else "application/json"})
            remaining = min((cap for cap in [self.deadline, self.stages[stage_id]["deadline"]] if cap is not None), default=float("inf")) - time.time()
            response = self.opener.open(request, timeout=max(.05, min(self.upstream_timeout, remaining)))
            with self.lock:
                self.responses.add(response)
            http_status = response.status
            operation = "downstream_headers"
            handler.send_response(http_status)
            handler.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
            handler.send_header("Connection", "close")
            handler.end_headers()
            started_response = True
            def observe(line):
                nonlocal usage, done, payload_error
                if not line.startswith(b"data:"):
                    return
                data = line[5:].strip()
                if data == b"[DONE]":
                    done = True
                    return
                try:
                    value = json.loads(data)
                    if isinstance(value, dict):
                        payload_error = payload_error or bool(value.get("error"))
                        found = self._usage(value.get("usage"))
                        if found is not None:
                            usage = found
                except (ValueError, UnicodeError):
                    pass
            while True:
                if self.closed.is_set():
                    status = "cancelled"
                    break
                if time.time() >= min((cap for cap in [self.deadline, self.stages[stage_id]["deadline"]] if cap is not None), default=float("inf")):
                    status = "deadline_interrupted"
                    break
                operation = "upstream_read"
                chunk = response.read1(65536)
                received_bytes += len(chunk)
                if not chunk:
                    status = "upstream_error_payload" if payload_error else ("success" if not streaming or done else "upstream_stream_incomplete")
                    break
                buffer += chunk
                if len(buffer) > 32 * 1024 * 1024:
                    status = "upstream_response_limit"
                    break
                if streaming:
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        observe(line.rstrip(b"\r"))
                operation = "downstream_write"
                handler.wfile.write(chunk)
                handler.wfile.flush()
                forwarded_bytes += len(chunk)
            if not streaming and status == "success":
                try:
                    value = json.loads(buffer)
                    usage = self._usage(value.get("usage"))
                    if value.get("error"):
                        status = "upstream_error_payload"
                except (ValueError, AttributeError) as error:
                    caught_error = error
                    status = "upstream_invalid_json"
        except urllib.error.HTTPError as error:
            caught_error = error
            http_status = error.code
            status = "upstream_http_error"
            # Do not reflect provider response bodies; they can contain secrets.
            self._reject(handler, 502, status)
            error.close()
        except (OSError, urllib.error.URLError, http.client.HTTPException) as error:
            caught_error = error
            status = ("client_disconnected" if isinstance(error, (BrokenPipeError, ConnectionResetError)) else "downstream_error") if operation.startswith('downstream_') else ("upstream_timeout" if (isinstance(error, TimeoutError) or isinstance(getattr(error, "reason", None), TimeoutError)) else "upstream_connection_error")
            if not started_response:
                self._reject(handler, 502, status)
        finally:
            if response:
                with self.lock:
                    self.responses.discard(response)
                response.close()
            handler.close_connection = True
            if status != 'success':
                chain = []; current = caught_error; seen = set()
                while isinstance(current, BaseException) and id(current) not in seen and len(chain) < 5:
                    seen.add(id(current))
                    chain.append({"type": type(current).__name__, "errno": current.errno if isinstance(getattr(current, 'errno', None), int) else None, "frames": [{"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name} for frame in traceback.extract_tb(current.__traceback__)[-6:]]})
                    current = current.__cause__ or current.__context__ or getattr(current, 'reason', None)
                record["transport_error"] = {"operation": operation, "exception_chain": chain, "received_bytes": received_bytes, "forwarded_bytes": forwarded_bytes, "elapsed_seconds": time.time()-record['started_at'], "stream_done": done, "http_status": http_status, "meter_closed": self.closed.is_set(), "terminal_status": status}
            self._finish(record, status, usage, http_status)

    def close(self):
        self.closed.set()
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
            # Active response streams normally close when their next chunk or
            # socket timeout arrives. Drain briefly; unreturned calls remain
            # explicitly in-flight/unknown in the final receipt, never zero-cost.
            until = time.time() + min(self.upstream_timeout + 2, 15)
            while time.time() < until and self.snapshot()["in_flight"]:
                time.sleep(.05)
        if hasattr(self, "heartbeat"):
            self.heartbeat.join(timeout=3)
        with self.lock:
            self._event({"event": "meter_closed", **self.snapshot()})
            if self.log:
                self.log.close()
                self.log = None
