"""A spending ledger for paid evaluation runs, kept on disk across invocations of the runner.

One ledger holds one approved budget. Every invocation that names it spends from the same
ceiling: a later invocation (a repeat of a failed scenario, a run resumed after a crash) sees
everything spent before it and cannot start with a fresh allowance.

Before a scenario starts, the most it may spend is written down as a reservation; when it ends,
the reservation is replaced by what it cost. A reservation that is never closed (the process was
killed, the machine stopped) stays charged at its full amount. The file is replaced atomically
after every change, so it is never half written.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class LedgerError(Exception):
    """The ledger refuses what was asked of it. Nothing was reserved or spent."""


@dataclass
class Ledger:
    path: Path
    max_cost_usd: float
    model: str
    entries: list[dict[str, Any]] = field(default_factory=list)

    # ── Opening ──

    @classmethod
    def open(cls, path: Path, max_cost_usd: float, model: str) -> Ledger:
        """Opens the ledger at `path`, or creates it with this ceiling. An existing ledger keeps
        the ceiling and model it was created with: asking for another one is refused."""
        if path.exists():
            data = json.loads(path.read_text())
            ledger = cls(path, float(data["maxCostUsd"]), str(data["model"]), list(data.get("entries") or []))
            if abs(ledger.max_cost_usd - max_cost_usd) > 1e-9:
                raise LedgerError(f"{path} was created for a ceiling of ${ledger.max_cost_usd:.2f}; this run asked for ${max_cost_usd:.2f}. A ledger's ceiling cannot be changed.")
            if ledger.model != model:
                raise LedgerError(f"{path} was created for {ledger.model}; this run is configured for {model}.")
            return ledger
        if max_cost_usd <= 0:
            raise LedgerError("The ceiling must be more than zero.")
        ledger = cls(path, max_cost_usd, model)
        ledger._save()
        return ledger

    # ── Reading ──

    def committed(self) -> float:
        """Spent so far, counting every reservation that was never closed at its full amount."""
        return sum(float(e["costUsd"]) if e["status"] == "done" else float(e["reservedUsd"]) for e in self.entries)

    def remaining(self) -> float:
        return self.max_cost_usd - self.committed()

    def attempts(self, scenario: str) -> list[dict[str, Any]]:
        return [e for e in self.entries if e["scenario"] == scenario]

    # ── Deciding what may run ──

    def check_allowed(self, scenarios: list[str], repeat: bool) -> None:
        """Refuses the whole invocation, before anything is spent, if any scenario may not run.

        A scenario runs at most twice: once, and once more only with `repeat`, only if its first
        attempt finished, was charged and failed.
        """
        for name in scenarios:
            previous = self.attempts(name)
            if not previous:
                if repeat:
                    raise LedgerError(f"{name} has not been run yet, so it cannot be repeated.")
                continue
            if not repeat:
                raise LedgerError(f"{name} has already been run against this ledger. Use --repeat to run a failed scenario once more.")
            if len(previous) >= 2:
                raise LedgerError(f"{name} has already been repeated once. It will not run again.")
            first = previous[0]
            if first["status"] != "done":
                raise LedgerError(f"The first attempt of {name} never finished, so what it cost is not known. It is charged at its reservation and will not be repeated.")
            if first.get("passed"):
                raise LedgerError(f"{name} passed on its first attempt. Only a failed scenario may be repeated.")

    # ── Spending ──

    def reserve(self, scenario: str, amount: float, run: str) -> dict[str, Any]:
        if amount <= 0 or amount > self.remaining() + 1e-12:
            raise LedgerError(f"Cannot reserve ${amount:.4f} for {scenario}: ${max(self.remaining(), 0):.4f} of the ${self.max_cost_usd:.2f} ceiling is left.")
        entry = {"scenario": scenario, "attempt": len(self.attempts(scenario)) + 1, "status": "reserved", "reservedUsd": amount, "costUsd": None, "run": run, "at": _now()}
        self.entries.append(entry)
        self._save()
        return entry

    def settle(self, entry: dict[str, Any], cost: float, *, passed: bool, unknown_usd: float = 0.0, calls: int = 0) -> None:
        if cost > entry["reservedUsd"] + 1e-9:
            # The provider refuses any call that could take a scenario past its reservation, so
            # this means the accounting is wrong. Record the real figure and say so loudly.
            entry["overrun"] = True
        entry.update(status="done", costUsd=cost, unknownUsd=unknown_usd, calls=calls, passed=passed, settled=_now())
        self._save()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {"maxCostUsd": self.max_cost_usd, "model": self.model, "entries": self.entries, "committedUsd": round(self.committed(), 6)}
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with tmp.open("w") as f:
            f.write(json.dumps(data, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())
        tmp.replace(self.path)


def _now() -> str:
    return datetime.now(UTC).isoformat()
