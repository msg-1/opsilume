# P7 host firewall (for the dedicated Linux test machine)

**Prepared, not applied.** No Linux test machine exists yet, and these rules have never run on one. The script's logic (apply, automatic rollback, confirm, remove, the boot path) was exercised only against stub `iptables` commands in a throwaway container (`test-with-stubs.sh`), which says nothing about real packet filtering. Nothing here was applied to the Mac or any other machine. Treat the first application as a test in itself, and follow the verification below before any qualifying cycle.

## Why Docker alone is not enough

- The harness container can reach the **test machine's own bridge addresses**. A host service listening on all addresses (sshd, for example) would be reachable from it.
- The **gateway container and the host** have ordinary outbound access. The gateway's code connects only to the recorder, but Docker doesn't confine it. Its self-check (port 8788, used by `p7.mjs netcheck`) also attempts a fixed list of destinations it must **not** reach, to show that these rules stop it; until the rules are applied, those attempts leave the machine (a TCP handshake, no data).

## What the rules do

`p7-firewall.sh print` shows them exactly. They match only the three bridges the Compose file names (`p7db0`, `p7gw0`, `p7eg0`).

| Traffic | Rule |
|---|---|
| From any harness bridge **to the host itself** | Dropped (replies to connections the host opened are allowed) |
| From the gateway bridge `p7eg0` outward | Allowed only to `RECORDER_IP:RECORDER_PORT` over TCP; everything else dropped. No DNS, no internet, no webhook destination |
| Leaving the internal bridges `p7db0`, `p7gw0` | Dropped. PostgreSQL stays inside the stack |
| IPv6 from the bridges to the host | Dropped (the networks are IPv4-only) |

**What they never touch:** the physical interface, sshd from the LAN, and any rule not tagged `p7-harness`. The operator's management access doesn't pass through these bridges, so it can't be cut by them.

**Assumptions to check on the machine:**
- Docker Engine uses iptables (the default), so the `DOCKER-USER` chain exists. On a distribution with the nftables backend, `iptables` is `iptables-nft` and works the same way.
- The recorder is given as an IPv4 address, in both `RECORDER_IP` and `P7_RECORDER_TARGET`.
- The bridge names are fixed, so only one P7 Compose project can exist on the machine at a time (remove any `HARNESS-SMOKE` project before creating another).
- No other firewall manager (ufw, firewalld) rewrites `INPUT` or `DOCKER-USER` afterwards. If one is active, record it and re-check after every reboot.

## Applying it safely

```bash
# 1. Look first. This changes nothing.
RECORDER_IP=<recorder> RECORDER_PORT=8787 ./p7-firewall.sh print

# 2. Apply, keeping your current ssh session open. Without a confirm, the rules remove themselves after 180 seconds.
sudo RECORDER_IP=<recorder> RECORDER_PORT=8787 ./p7-firewall.sh apply

# 3. From your own machine, open a NEW ssh session to the test machine. If it works:
sudo ./p7-firewall.sh confirm

# 4. Make it survive power cuts: the rules must exist BEFORE Docker restarts the stack at boot. The unit applies them
#    without the rollback timer, and Docker does not start if it fails.
RECORDER_IP=<recorder> RECORDER_PORT=8787 ./p7-firewall.sh unit | sudo tee /etc/systemd/system/p7-firewall.service
sudo systemctl daemon-reload && sudo systemctl enable p7-firewall.service
```

To undo everything: `sudo ./p7-firewall.sh remove` (and `sudo systemctl disable p7-firewall.service`).

## Verification, with expected results

Run these on the test machine after step 3, and again after a reboot.

| # | Command | Expected |
|---|---|---|
| 1 | `sudo ./p7-firewall.sh status` | The tagged rules are listed under `INPUT`, `DOCKER-USER`, `P7-HOST` and `P7-EGRESS` |
| 2 | `ssh <test machine>` from the operator's machine, in a new session | Connects as before |
| 3 | `docker compose exec -T harness node p7.mjs netcheck` (in a `POWER-CUT` run, so it is strict) | Exit 0. "recorder through the gateway, authenticated" is reachable; every "host or bridge" probe reports `timeout`, never `refused` or `connected`; internet and DNS probes fail |
| 4 | `docker compose exec -T gateway node -e "require('net').connect({host:'1.1.1.1',port:443}).setTimeout(4000,()=>{console.log('timeout');process.exit(0)}).on('connect',()=>{console.log('CONNECTED');process.exit(1)}).on('error',e=>{console.log(e.code);process.exit(0)})"` | `timeout`. The gateway itself can't reach the internet |
| 5 | The same command with the recorder's address and port | `CONNECTED` (exit 1 here means reachable, which is wanted) |
| 6 | The same command with the recorder's address and another port, for example 22 | `timeout` |
| 7 | `docker compose exec -T harness node -e "require('net').connect({host:'db',port:5432}).on('connect',()=>{console.log('connected');process.exit(0)})"` | `connected`. PostgreSQL still works inside the stack |
| 8 | `sudo ss -ltnp` on the host | PostgreSQL's port 5432 isn't listening on the host: nothing is published |
| 9 | After a reboot: `systemctl is-active p7-firewall.service`, then rows 1 and 3 again | `active`, and the same results, before the first cycle of that boot |

`p7.mjs run` repeats check 3 before every cycle and refuses to start if it fails. Checks 4 to 6 are not automated: the operator runs them once per boot and records the output with the host evidence.

## Known limits

- The rules can't be tested until the machine exists. Row 3's "timeout" expectation is the design's intent, not a result.
- The recorder host isn't covered. It should accept the recorder port only from the test machine, and run nothing else for the experiment.
- The host keeps its own outbound access (for the operator and for time synchronisation). Only container traffic is restricted.
