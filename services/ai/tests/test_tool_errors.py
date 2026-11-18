"""What a failed tool call says. Its text reaches the report (uncertainties, missing telemetry), which people
read, including visitors of the public demo: it must not carry internal addresses or another system's body."""

import httpx
import pytest

from app.tools import ToolClient, ToolError

INTERNAL = "http://api:4000/api/v1/tools/logs/search"


async def test_an_unreachable_api_is_reported_without_its_address():
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"[Errno 111] Connection refused for url '{INTERNAL}'", request=request)

    client = ToolClient("http://api:4000", "secret-tool-token", transport=httpx.MockTransport(refuse))
    with pytest.raises(ToolError) as caught:
        await client.call("search_logs", {"from_time": "1h"})
    await client.aclose()
    message = str(caught.value)
    assert message == "OPSILUME API is not reachable (ConnectError)"
    assert "api:4000" not in message and "Errno" not in message and "secret-tool-token" not in message


async def test_a_response_that_is_not_the_apis_own_error_is_not_repeated():
    page = "<html>502 Bad Gateway nginx at 10.0.3.7 /var/lib/upstream</html>"
    client = ToolClient("http://api:4000", "tok", transport=httpx.MockTransport(lambda _r: httpx.Response(502, text=page)))
    with pytest.raises(ToolError) as caught:
        await client.call("search_logs", {"from_time": "1h"})
    await client.aclose()
    assert str(caught.value) == "search_logs failed (502): unexpected response"


async def test_the_apis_own_error_message_is_kept():
    client = ToolClient("http://api:4000", "tok", transport=httpx.MockTransport(lambda _r: httpx.Response(400, json={"error": {"message": "from_time is not a valid time"}})))
    with pytest.raises(ToolError, match=r"search_logs failed \(400\): from_time is not a valid time"):
        await client.call("search_logs", {"from_time": "1h"})
    await client.aclose()
