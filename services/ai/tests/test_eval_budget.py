"""The spending ceiling of a paid evaluation run, property by property, against a MOCKED API.

Nothing here calls Anthropic. Each test proves one of the properties a live run relies on:
the total is cumulative; a scenario cannot exceed what it was given; every call is reserved at
its upper bound before it is sent; output is limited; cache writes are priced; long prompts are
priced at the higher tier and refused in an evaluation; retries cannot spend outside the
budget; a call of unknown outcome is charged and not retried; a scenario that cannot fit does
not start; and a repeat spends from the same ledger, never from a fresh budget.
"""

import json
from pathlib import Path

import anthropic
import httpx2
import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.config import EVAL_MAX_PROMPT_TOKENS, Settings
from app.evals import run as evals
from app.evals.ledger import Ledger, LedgerError
from app.evals.scenarios import SCENARIOS
from app.llm import (
    AnthropicProvider,
    LLMError,
    Resolution,
    Usage,
    build_provider,
    call_cost_bound,
    price_for,
    prompt_token_bound,
)
from app.mock_provider import MockProvider
from app.tools import TOOLS

from .test_claude_provider import FAKE_KEY, FakeAnthropic, api_error, message, text, tool_use

HAIKU = "claude-haiku-5-5"
FULL = {"input_tokens": 1_000, "output_tokens": 8_000}  # a call that uses its whole output allowance


def strict(api: FakeAnthropic, limit: float, **overrides) -> AnthropicProvider:
    """A provider configured exactly as the paid evaluation configures one."""
    settings = evals.live_settings(Settings(_env_file=None, anthropic_api_key=FAKE_KEY, ai_provider="anthropic", **overrides), HAIKU, limit)
    client = anthropic.AsyncAnthropic(api_key=FAKE_KEY, http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(api.handler)), max_retries=settings.ai_max_retries, timeout=5)
    return AnthropicProvider(settings, client=client)


def looping(n: int) -> list:
    return [message([tool_use(f"t{i}", "list_deployments", {})], "tool_use", usage=FULL) for i in range(n)]


# 1 and 9: cumulative across scenarios; a scenario that cannot fit does not start.


async def test_the_ceiling_is_cumulative_over_all_scenarios_and_a_scenario_that_cannot_fit_never_starts(tmp_path):
    ledger = Ledger.open(tmp_path / "ledger.json", 0.10, HAIKU)
    built: list[float] = []

    def fake_build(resolution, settings):
        provider = MockProvider(settings)
        built.append(settings.ai_max_cost_usd_per_investigation)
        provider.usage.cost_usd = 0.02
        return provider

    original, evals.build_provider = evals.build_provider, fake_build
    try:
        results, skipped = await evals.run_all(Resolution("anthropic", HAIKU, True, ""), Settings(_env_file=None), 0.10, log=lambda *_: None, ledger=ledger)
    finally:
        evals.build_provider = original
    reserve = evals.worst_case_call_usd(HAIKU, Settings(_env_file=None))
    # Each start needs 1.25 x the last cost plus one worst-case call: 0.025 + 0.01625 = 0.04125.
    # After three scenarios 0.04 is left, so the fourth is not started and no provider is built.
    assert [r.cost_usd for r in results] == [0.02, 0.02, 0.02]
    assert len(built) == 3 and skipped == [s.name for s in SCENARIOS[3:]]
    assert ledger.committed() == pytest.approx(0.06) and ledger.remaining() < 0.025 + reserve  # why the fourth did not start
    # Each scenario was given exactly what was left, so the total can never pass the ceiling.
    assert built == pytest.approx([0.10, 0.08, 0.06])
    saved = json.loads((tmp_path / "ledger.json").read_text())
    assert [e["status"] for e in saved["entries"]] == ["done"] * 3 and saved["committedUsd"] == pytest.approx(0.06)


# 2 and 3: a scenario cannot exceed its limit; every call is reserved before it is sent.


async def test_a_scenario_never_spends_more_than_its_limit_however_long_the_model_keeps_calling_tools():
    api = FakeAnthropic(looping(50))
    provider = strict(api, 0.02)
    sent = 0
    with pytest.raises(LLMError) as stop:
        while True:
            await provider.invoke([HumanMessage("investigate")], TOOLS)
            sent += 1
    assert stop.value.kind == "budget" and stop.value.fatal and "was not sent" in str(stop.value)
    assert provider.usage.cost_usd <= 0.02
    # The refused call was never sent: the API saw exactly the calls that were paid for.
    assert len(api.requests) == sent == provider.usage.calls


async def test_a_call_whose_upper_bound_does_not_fit_is_refused_before_anything_is_sent():
    api = FakeAnthropic([message([text("never")])])
    probe = strict(api, 1.0)
    bound = probe.reserve(probe._base([HumanMessage("hello")]))
    assert bound is not None and bound > 8_000 * 0.50 / 1e6  # the full output allowance is in it
    provider = strict(api, bound * 0.99)
    with pytest.raises(LLMError, match="was not sent"):
        await provider.invoke([HumanMessage("hello")], [])
    assert api.requests == [] and provider.usage.calls == 0


async def test_output_is_counted_again_only_where_it_is_sent_back():
    api = FakeAnthropic([message([tool_use("t1", "list_deployments", {})], "tool_use", usage=FULL)])
    provider = strict(api, 0.50)
    await provider.invoke([HumanMessage("go")], TOOLS)
    fresh = provider._base([HumanMessage("write the report")])
    loop = provider._base([HumanMessage("go"), AIMessage(content="", tool_calls=[{"id": "t1", "name": "list_deployments", "args": {}, "type": "tool_call"}]), ToolMessage("[]", tool_call_id="t1")])
    provider.reserve(fresh)
    without = provider._reserved_prompt
    provider.reserve(loop)
    # The tool loop's 8,000 output tokens can be billed again only in a request that replays them.
    assert without == prompt_token_bound(fresh) and provider._reserved_prompt == prompt_token_bound(loop) + 8_000


async def test_a_bill_larger_than_its_bound_stops_the_scenario_and_the_run(tmp_path):
    api = FakeAnthropic([message([text("hi")], usage={"input_tokens": 500_000, "output_tokens": 10})])
    provider = strict(api, 0.50)
    with pytest.raises(LLMError, match="Spending accounting failed") as tripped:
        await provider.invoke([HumanMessage("hi")], [])
    assert tripped.value.fatal and provider.bound_exceeded and "500,000 prompt tokens" in provider.bound_exceeded

    ledger = Ledger.open(tmp_path / "ledger.json", 1.00, HAIKU)

    def overrunning(resolution, settings):
        mock = MockProvider(settings)
        mock.usage.cost_usd = 0.01
        mock.bound_exceeded = "a response used more than was reserved"
        return mock

    original, evals.build_provider = evals.build_provider, overrunning
    try:
        results, skipped = await evals.run_all(Resolution("anthropic", HAIKU, True, ""), Settings(_env_file=None), 1.00, log=lambda *_: None, ledger=ledger)
    finally:
        evals.build_provider = original
    assert len(results) == 1 and skipped == [s.name for s in SCENARIOS[1:]]


def test_the_provider_the_runner_builds_really_does_not_retry():
    settings = evals.live_settings(Settings(_env_file=None, anthropic_api_key=FAKE_KEY, ai_provider="anthropic"), HAIKU, 0.50)
    provider = build_provider(Resolution("anthropic", HAIKU, True, ""), settings)
    assert isinstance(provider, AnthropicProvider) and provider._client.max_retries == 0
    assert settings.ai_strict_spending and settings.ai_expected_model == HAIKU and settings.ai_max_prompt_tokens == EVAL_MAX_PROMPT_TOKENS


def test_the_prompt_bound_is_never_below_the_bytes_sent_and_counts_replayed_thinking():
    params = {"system": "s" * 1_000, "messages": [{"role": "user", "content": "é" * 500}], "tools": [{"name": "x", "input_schema": {}}]}
    bound = prompt_token_bound(params)
    assert bound >= 1_000 + 2 * 500 + 2_000  # é is two bytes; framing is allowed for on top
    assert prompt_token_bound(params, replayed_output_tokens=7_000) == bound + 7_000


# 4: output is limited on every request.


async def test_every_request_asks_for_at_most_the_configured_output():
    api = FakeAnthropic(looping(3))
    provider = strict(api, 0.50)
    for _ in range(3):
        await provider.invoke([HumanMessage("go")], TOOLS)
    assert [r["body"]["max_tokens"] for r in api.requests] == [8_000] * 3
    assert all("temperature" not in r["body"] and "thinking" not in r["body"] for r in api.requests)


# 5 and 6: cache writes are priced; long prompts are priced higher, and refused in an evaluation.


def test_cache_writes_and_the_long_prompt_tier_are_priced_as_published():
    usage = Usage()
    usage.record(HAIKU, None, input_tokens=1_000, output_tokens=1_000, cache_read=10_000, cache_write=20_000)
    assert usage.cost_usd == pytest.approx((1_000 * 0.10 + 1_000 * 0.50 + 10_000 * 0.01 + 20_000 * 0.125) / 1e6)
    # The tier is decided by the whole prompt, cache reads and writes included.
    long = Usage()
    long.record(HAIKU, None, input_tokens=1_000, output_tokens=1_000, cache_read=60_000, cache_write=40_000)
    assert long.cost_usd == pytest.approx((1_000 * 0.50 + 1_000 * 2.50 + 60_000 * 0.05 + 40_000 * 0.625) / 1e6)
    # The bound prices every prompt token at the dearest input rate, at the tier the size reaches.
    assert call_cost_bound(HAIKU, 50_000, 8_000, None) == pytest.approx((50_000 * 0.125 + 8_000 * 0.50) / 1e6)
    assert call_cost_bound(HAIKU, 150_000, 8_000, None) == pytest.approx((150_000 * 0.625 + 8_000 * 2.50) / 1e6)
    assert price_for(HAIKU, 100_000, None)[0] == 0.10 and price_for(HAIKU, 100_001, None)[0] == 0.50


async def test_an_evaluation_never_sends_a_prompt_that_could_reach_the_higher_prices():
    assert EVAL_MAX_PROMPT_TOKENS < 100_000
    api = FakeAnthropic([message([text("never")])])
    provider = strict(api, 1.0)
    with pytest.raises(LLMError, match="over the limit of 98,000") as refused:
        await provider.invoke([HumanMessage("x" * 97_000)], [])
    assert refused.value.kind == "budget" and api.requests == []


# 7 and 8: retries cannot spend outside the budget; an ambiguous call is charged and not retried.


@pytest.mark.parametrize("failure", [httpx2.ReadTimeout("timed out"), api_error(500, "api_error", "boom"), api_error(529, "overloaded_error", "busy")])
async def test_a_call_of_unknown_outcome_is_sent_once_and_charged_at_its_upper_bound(failure):
    api = FakeAnthropic([failure, message([text("a retry must not happen")])])
    provider = strict(api, 0.50)
    bound = provider.reserve({**provider._base([HumanMessage("hi")]), "tools": []})  # as invoke() builds it
    with pytest.raises(LLMError):
        await provider.invoke([HumanMessage("hi")], [])
    assert len(api.requests) == 1  # no retry, by the SDK or by us
    assert provider.usage.unknown_calls == 1 and provider.usage.calls == 1
    assert provider.usage.cost_usd == pytest.approx(bound) == pytest.approx(provider.usage.unknown_cost_usd)


@pytest.mark.parametrize("refusal", [api_error(429, "rate_limit_error", "slow down", {"retry-after": "0"}), api_error(400, "invalid_request_error", "bad"), api_error(401, "authentication_error", "no")])
async def test_a_request_refused_before_any_work_is_not_charged_and_not_retried(refusal):
    api = FakeAnthropic([refusal, message([text("a retry must not happen")])])
    provider = strict(api, 0.50)
    with pytest.raises(LLMError):
        await provider.invoke([HumanMessage("hi")], [])
    assert len(api.requests) == 1 and provider.usage.cost_usd == 0 and provider.usage.unknown_calls == 0


async def test_if_retries_were_allowed_each_one_would_be_reserved_too():
    api = FakeAnthropic([message([text("ok")])])
    once = strict(api, 1.0)
    thrice = AnthropicProvider(once.settings.model_copy(update={"ai_max_retries": 2}), client=once._client)
    params = once._base([HumanMessage("hi")])
    assert thrice.reserve(params) == pytest.approx(3 * once.reserve(params))
    assert once.settings.ai_max_retries == 0  # the evaluation itself never retries


async def test_a_response_from_another_model_stops_the_model_calls():
    api = FakeAnthropic([message([text("hi")], model="claude-sonnet-5-5"), message([text("dated snapshot")], model="claude-haiku-5-5-20261007")])
    provider = strict(api, 0.50)
    with pytest.raises(LLMError, match="not claude-haiku-5-5") as wrong:
        await provider.invoke([HumanMessage("hi")], [])
    assert wrong.value.fatal and provider.usage.calls == 1  # what it cost is still counted
    assert (await provider.invoke([HumanMessage("hi")], [])).content == "dated snapshot"


def test_investigations_outside_the_evaluation_keep_the_plain_accounting():
    settings = Settings(_env_file=None, anthropic_api_key=FAKE_KEY)
    assert settings.ai_strict_spending is False and settings.ai_max_prompt_tokens == 0 and settings.ai_expected_model == ""
    provider = AnthropicProvider(settings)
    assert provider.reserve(provider._base([HumanMessage("hi")])) is None


# 10: a repeat spends from the same ledger and cannot reset it.


def test_a_repeat_spends_from_the_same_ledger_and_cannot_reset_or_repeat_twice(tmp_path):
    path = tmp_path / "ledger.json"
    first = Ledger.open(path, 1.00, HAIKU)
    a = first.reserve("healthy_clean", 0.50, "run-1")
    first.settle(a, 0.03, passed=False)
    b = first.reserve("healthy_no_signal", 0.50, "run-1")
    first.settle(b, 0.04, passed=True)

    # A second invocation sees what was spent, and cannot open the ledger with another ceiling.
    again = Ledger.open(path, 1.00, HAIKU)
    assert again.committed() == pytest.approx(0.07) and again.remaining() == pytest.approx(0.93)
    with pytest.raises(LedgerError, match="cannot be changed"):
        Ledger.open(path, 2.00, HAIKU)
    with pytest.raises(LedgerError, match="created for claude-haiku-5-5"):
        Ledger.open(path, 1.00, "claude-sonnet-5-5")

    # Without --repeat nothing already run may run; with it, only a failed scenario, once.
    with pytest.raises(LedgerError, match="already been run"):
        again.check_allowed(["healthy_clean"], repeat=False)
    with pytest.raises(LedgerError, match="passed on its first attempt"):
        again.check_allowed(["healthy_no_signal"], repeat=True)
    with pytest.raises(LedgerError, match="has not been run yet"):
        again.check_allowed(["healthy_old_deployment"], repeat=True)
    again.check_allowed(["healthy_clean"], repeat=True)
    c = again.reserve("healthy_clean", 0.50, "run-2")
    again.settle(c, 0.05, passed=False)
    assert c["attempt"] == 2 and again.committed() == pytest.approx(0.12)
    with pytest.raises(LedgerError, match="1 already used"):  # the one repeat of the whole ledger is spent
        Ledger.open(path, 1.00, HAIKU).check_allowed(["healthy_clean"], repeat=True)
    roomy = Ledger(path, 1.00, HAIKU, again.entries, max_repeats=5)  # even with room, never a third attempt
    with pytest.raises(LedgerError, match="already been repeated once"):
        roomy.check_allowed(["healthy_clean"], repeat=True)


def test_a_reservation_that_was_never_closed_stays_charged_and_blocks_a_repeat(tmp_path):
    path = tmp_path / "ledger.json"
    ledger = Ledger.open(path, 1.00, HAIKU)
    ledger.reserve("healthy_clean", 0.40, "run-1")  # the process dies here
    reopened = Ledger.open(path, 1.00, HAIKU)
    assert reopened.committed() == pytest.approx(0.40) and reopened.remaining() == pytest.approx(0.60)
    with pytest.raises(LedgerError, match="never finished"):
        reopened.check_allowed(["healthy_clean"], repeat=True)
    with pytest.raises(LedgerError, match="Cannot reserve"):
        reopened.reserve("healthy_no_signal", 0.61, "run-2")


async def test_a_scenario_that_crashes_leaves_its_reservation_charged(tmp_path):
    ledger = Ledger.open(tmp_path / "ledger.json", 1.00, HAIKU)

    async def crash(*_a, **_k):
        raise RuntimeError("worker died")

    original_build, original_eval = evals.build_provider, evals.evaluate
    evals.build_provider, evals.evaluate = (lambda r, s: MockProvider(s)), crash
    try:
        with pytest.raises(RuntimeError):
            await evals.run_all(Resolution("anthropic", HAIKU, True, ""), Settings(_env_file=None), 1.00, log=lambda *_: None, ledger=ledger)
    finally:
        evals.build_provider, evals.evaluate = original_build, original_eval
    assert ledger.committed() == pytest.approx(0.50)  # the whole per-scenario limit, until shown otherwise


# The runner itself: no .env, no paid run without a ledger, and an estimate that calls nothing.


def run_main(monkeypatch, capsys, *argv: str) -> tuple[int, str, str]:
    monkeypatch.setattr("sys.argv", ["run", *argv])
    with pytest.raises(SystemExit) as done:
        evals.main()
    out = capsys.readouterr()
    return int(done.value.code or 0), out.out, out.err


def test_the_runner_never_reads_the_repository_env_file(monkeypatch, capsys, tmp_path):
    env = tmp_path / ".env"
    env.write_text(f"AI_PROVIDER=anthropic\nANTHROPIC_API_KEY={FAKE_KEY}\n")
    monkeypatch.setitem(Settings.model_config, "env_file", str(env))
    for name in ("AI_PROVIDER", "LLM_PROVIDER", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    assert Settings().anthropic_api_key == FAKE_KEY  # what the file would have given
    code, out, _ = run_main(monkeypatch, capsys, "--estimate")
    assert code == 0 and "not set to anthropic" in out


def test_a_paid_run_is_refused_without_a_ledger_or_with_price_overrides(monkeypatch, capsys):
    monkeypatch.setenv("AI_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)
    monkeypatch.setattr(anthropic, "AsyncAnthropic", lambda *a, **k: pytest.fail("no client may be created"))
    code, _, err = run_main(monkeypatch, capsys, "--max-cost", "1.00")
    assert code == 2 and "--ledger FILE is required" in err and "--model must name the approved model" in err and "--key-env NAME is required" in err
    code, _, err = run_main(monkeypatch, capsys, "--max-cost", "1.00", "--ledger", "x.json", "--model", "claude-sonnet-5-5")
    assert code == 2 and "--model must name the approved model exactly (configured: claude-haiku-5-5)" in err
    monkeypatch.setenv("AI_PRICE_INPUT_PER_MTOK", "0.0")
    monkeypatch.setenv("AI_PRICE_OUTPUT_PER_MTOK", "0.0")
    code, _, err = run_main(monkeypatch, capsys, "--max-cost", "1.00", "--ledger", "x.json")
    assert code == 2 and "price overrides" in err and not Path("x.json").exists()


def test_the_estimate_calls_nothing_and_never_shows_the_key(monkeypatch, capsys):
    monkeypatch.setenv("AI_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)
    monkeypatch.setattr(anthropic, "AsyncAnthropic", lambda *a, **k: pytest.fail("no client may be created"))
    code, out, _ = run_main(monkeypatch, capsys, "--estimate")
    assert code == 0 and "No model was called." in out and FAKE_KEY not in out
    assert "claude-haiku-5-5" in out and "SDK retries 0" in out and "$0.01625" in out and "15 model calls each, 210 in all" in out


def test_only_one_repeat_is_allowed_across_all_scenarios(tmp_path):
    ledger = Ledger.open(tmp_path / "ledger.json", 0.87, HAIKU)
    for name in ("healthy_clean", "healthy_no_signal"):
        ledger.settle(ledger.reserve(name, 0.10, "run-1"), 0.02, passed=False)
    with pytest.raises(LedgerError, match="1 repeat\\(s\\) across all scenarios; 0 already used and 2 asked for"):
        ledger.check_allowed(["healthy_clean", "healthy_no_signal"], repeat=True)
    ledger.check_allowed(["healthy_clean"], repeat=True)
    ledger.settle(ledger.reserve("healthy_clean", 0.10, "run-2"), 0.02, passed=False)
    reopened = Ledger.open(tmp_path / "ledger.json", 0.87, HAIKU)
    assert reopened.max_repeats == 1 and reopened.repeats_used() == 1
    with pytest.raises(LedgerError, match="1 already used"):
        reopened.check_allowed(["healthy_no_signal"], repeat=True)


def test_the_key_is_read_only_from_the_named_variable(monkeypatch, capsys):
    monkeypatch.setenv("AI_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)  # present, but not the one named
    monkeypatch.delenv("OPSILUME_TEST_KEY", raising=False)
    monkeypatch.setattr(anthropic, "AsyncAnthropic", lambda *a, **k: pytest.fail("no client may be created"))
    code, _, err = run_main(monkeypatch, capsys, "--model", HAIKU, "--max-cost", "0.87", "--ledger", "x.json", "--key-env", "OPSILUME_TEST_KEY")
    assert code == 2 and "no key is set in OPSILUME_TEST_KEY" in err and FAKE_KEY not in err and not Path("x.json").exists()
    monkeypatch.setenv("OPSILUME_TEST_KEY", FAKE_KEY)
    code, out, _ = run_main(monkeypatch, capsys, "--estimate", "--key-env", "OPSILUME_TEST_KEY")
    assert code == 0 and "OPSILUME_TEST_KEY is set" in out and FAKE_KEY not in out
