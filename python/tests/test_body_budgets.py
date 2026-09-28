import sys
from pathlib import Path
for sdk_package in ("python", "fastapi"):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / sdk_package / "src"))
import asyncio
import unittest
from starlette.requests import Request
from devora_sdk_fastapi.adapter import _read_bounded_body, _BodyReadError


class BodyBudgetTests(unittest.TestCase):
    def test_missing_length_is_bounded_while_streaming(self):
        calls = 0
        async def receive():
            nonlocal calls
            calls += 1
            return {"type": "http.request", "body": b" " * 256, "more_body": True}
        request = Request({"type": "http", "method": "POST", "headers": []}, receive=receive)
        with self.assertRaises(_BodyReadError) as raised:
            asyncio.run(_read_bounded_body(request, 1024))
        self.assertEqual(raised.exception.status, 413)
        self.assertEqual(calls, 5)

    def test_stalled_receive_is_cancelled_on_deadline(self):
        cancelled = False
        async def receive():
            nonlocal cancelled
            try:
                await asyncio.sleep(60)
            finally:
                cancelled = True
        request = Request({"type": "http", "method": "POST", "headers": []}, receive=receive)
        with self.assertRaises(_BodyReadError) as raised:
            asyncio.run(_read_bounded_body(request, 1024, timeout=0.01))
        self.assertEqual(raised.exception.status, 408)
        self.assertTrue(cancelled)


    def test_actual_endpoint_rejects_before_signature_processing(self):
        from types import SimpleNamespace
        from devora_sdk_fastapi.adapter import _endpoint_for_route, FastAPIAdapterOptions
        calls = 0
        async def receive():
            nonlocal calls
            calls += 1
            return {"type": "http.request", "body": b" " * 256, "more_body": True}
        request = Request({"type": "http", "method": "POST", "headers": [], "path": "/test", "query_string": b"", "scheme": "http"}, receive=receive)
        endpoint = _endpoint_for_route(object(), [], SimpleNamespace(path="/test"), FastAPIAdapterOptions(max_body_size=1024))
        response = asyncio.run(endpoint(request))
        self.assertEqual(response.status_code, 413)
        self.assertEqual(calls, 5)
