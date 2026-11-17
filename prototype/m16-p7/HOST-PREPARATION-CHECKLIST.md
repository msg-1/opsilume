# P7 real-host preparation checklist

**Goal:** prepare the borrowed, dedicated Linux machine and reach `READY_FOR_OPERATOR_REVIEW`, confirmed by the recorder. **It ends there.**

**Not authorised by this checklist:** `p7.mjs run` on the qualifying run, `recorder.mjs cut` on it, or any physical power cut. **The 20 physical power-cut cycles need the product owner's separate, explicit authorisation.**

**Status:** revised 18 November 2026: the product owner's decisions B1 to B6, the final pre-host safety corrections, an enforced maximum burst rate, recorder-side verification of the source package, generation-named smoke volumes, and the two decisions of 18 November (a failed journal write fails closed; the quiet rate is at least 0.2 claims per second). This is a **smoke rehearsal and preparation** procedure: it contains no qualifying cycle and no physical power cut. Nothing in it has been executed on a real Linux host. P7 remains **NOT TESTED and NOT PASSED**. `READY_FOR_OPERATOR_REVIEW` is not approval.

**Markers**
- **[REVIEW]** the harness cannot define this for you (it depends on the machine or the plug). Settle it, and record what was done.
- **[OPEN]** not resolved; see section 0.

**Names used below**

| Name | Meaning |
|---|---|
| `<pkg>` | The extracted source package on the test machine. Never move or edit it once the firewall unit is installed |
| `<harness>` | `<pkg>/prototype/m16-p7` on the test machine; the harness directory of the reviewed checkout on the recorder host |
| `<recorder-ip>` | The recorder host's IPv4 address on the LAN (an address, not a name) |
| `<recorder-dir>`, `<backup>` | The new recorder directory, and its copy on another disk or machine |
| `<evidence>` | An absolute directory on the test machine, outside `<pkg>`, that survives a reboot |
| `<smoke-run>`, `<run>` | The rehearsal run id (for example `host-smoke-1`) and the qualifying run id (for example `p7-1`) |
| `<key>` | A run's key file on the test machine, mode 0600, in a directory that survives a reboot (not `/tmp`, not `/run`) |

**Rules for the whole session**
- Never run `docker compose down -v`, `docker volume rm`, `docker volume prune`, `docker system prune`, or `smoke-teardown.sh`.
- Never pass `-y`/`--yes` to `docker compose up`; decline any offer to recreate a volume.
- **The two projects stay separate.** Every smoke command carries the smoke project and both files. Define this in every shell on the test machine (again after each reboot):
  ```bash
  cd <harness>
  export P7_SMOKE_GENERATION=<generation>     # lower-case letters and digits, for example h1; the same for the whole rehearsal
  smoke() { docker compose -p opspilot-m16-p7-smoke -f compose.yml -f compose.smoke.yml "$@"; }
  ```
  The smoke volumes are named with the generation (`opspilot-m16-p7-smoke_pgdata_<generation>`, `..._state_<generation>`), so a smoke environment always has volumes of its own; Compose refuses a smoke command without `P7_SMOKE_GENERATION`.
  A bare `docker compose` in `<harness>` is the **qualifying** project `opspilot-m16-p7`. Using it before step 13 creates the qualifying volumes early.
- Every Compose command needs `P7_RUN`, `P7_RECORDER_TARGET` and `P7_KEY_FILE_HOST` exported in that shell, or Compose refuses.
- `sudo` drops the environment: write `sudo VAR=value ./script`, as shown.
- The run key is never printed, pasted, logged or copied into evidence.
- The inspection tools are used read-only. Never change firmware, a write-cache setting, a partition or any storage configuration.
- When a step says stop: change nothing further, keep everything as it is, and report.

## Order of execution

The steps are numbered by subject. Three are done in two parts, because of how the harness works:

| Phase | Steps |
|---|---|
| A. Before touching the machine | 0, 1, 1a (package) |
| B. Machine and storage | 2, 1a (verify, build), 3, 5 (read the Compose file), 7a (new recorder directory) |
| C. Firewall before any stack runs | 8, 9a (checks 1, 2, 8) |
| D. Smoke rehearsal, project `opspilot-m16-p7-smoke` | 11 (start), 6 and 4 (flush probe, storage evidence), 9a (checks 3 to 7), **12 (first capture, before any reboot)**, 10, 11 (reboot, recovery), 12 (second capture, comparison, cycle 2) |
| E. Between the projects | 7b (backup, verify), final smoke host evidence, smoke containers and networks removed with `smoke-containers-down.sh` (volumes kept) |
| F. Qualifying project `opspilot-m16-p7`, before `init` | 13, 5 (as read), 6 (baseline), 9b (all nine checks, strict), 14 |
| G. Readiness | 15, then 16 and stop |

## 0. Decisions of 17 November 2026, and what is still open

| # | Decision | Where it is applied |
|---|---|---|
| B1 | **One process, one worker, one immutable workload with a predefined burst pattern and a maximum burst rate,** the same in every one of the 20 cycles. Concurrency is not raised to approach the clearance limit. If sizing cannot support the workload, stop and report | Step 15. The recorder accepts a readiness record only for one process and one worker with a burst pattern, never replaces it, and refuses any start whose workload differs in any field |
| B2 | **The cut is rehearsed without cutting power.** The operator sequence and the smart-plug procedure are exercised; `confirm-cut` is answered `no`. The rehearsal is evidence of the procedure only, never a physical power-cut cycle | Step 10 |
| B3 | **The image is built natively on the Linux host** from a source package of the exact reviewed commit, with a verified SHA-256 checksum. No Mac-built image, no push | Step 1a |
| B4 | **`smartmontools`, `pciutils`, `hdparm` and `nvme-cli` may be installed,** with the owner's written permission, for read-only inspection | Steps 1, 2, 4 |
| B5 | **Baseline: Ubuntu 24.04 LTS, kernel 5.5 or newer, a dedicated local SSD, local ext4 for PostgreSQL 16 and the journal.** No overlay storage for the journal, no network filesystem. If the host cannot meet it, stop and request review | Steps 2, 3, 5 |
| B6 | **Fail-stop after a claimed `init`.** An `init` refused before the claim may be retried, after review, with a new run id, only if the volumes are demonstrably empty. An `init` that fails after the claim, or whose outcome is uncertain, preserves all state and stops the qualifying session. No cleanup, reset, deletion or reuse; `abandon` closes the failed run; no other Compose project name is introduced | Step 15 |

**Still open**

| # | Item |
|---|---|
| O1 | **A failed claimed `init` ends the qualifying session.** It needs investigation and the product owner's separate authorisation before any new qualifying attempt. There is no procedure for one here, by decision |
| O2 | **[REVIEW] The smart plug's command.** It depends on the plug. The recorder runs it (`cut --command-json`) and records only its exit status |
| O3 | **[OPEN] The burst workload's four numbers:** the maximum burst rate, the burst seconds, the burst period and the quiet rate. The harness enforces whatever the readiness record holds, in sizing and in execution. This checklist writes the pattern as 10 burst seconds in every 60 and 50 claims per second between, which is a proposal; the maximum burst rate is deliberately left blank. **None of them is approved.** They are to be decided by the product owner after the one-worker measurement of step 10, and before step 15. One bound comes from the harness itself: the quiet rate must be at least 0.2 claims per second, or a paced worker would look stopped to the recorder (it counts 10 s of silence before the cut as a stop). That floor was accepted on 18 November 2026 as an eligibility floor: `preflight`, `run` and the recorder all refuse a lower quiet rate. It is not a workload selection; the four numbers remain undecided |
| O4 | **The image id is declared, not observed.** Nothing inside a container can read the id of the image it runs from. The recorder binds the declared id and checks the source by content and the architecture; the id itself is compared by the operator in the host evidence (step 6). Keep the package and both images unchanged for the whole series. **Nothing shows that the image was built from the package:** the recorder compares the harness files in the package with the files on its own disk, and covers the rest of the package (what the image is built from) by its checksum only. The commit id is read from the archive's own header and is not checked against a repository. The recorder checks the files on its disk, not the code its running `serve` process loaded: start `serve` from the reviewed checkout and restart it after any change, before `create-run` |
| O5 | **Never observed on a real host, or in any container:** the firewall rules, the strict network check, the gateway's new listener binding, the burst workload, `READY_FOR_OPERATOR_REVIEW` end to end, and whether the bound values survive a reboot. Steps 8 to 12 and 15 are the first observations |

## 1. Machine ownership and written permission

- **Preconditions:** none.
- **Action:** obtain the owner's agreement **in writing** to all of:
  - repeated hard power cuts, and possible SSD wear or damage;
  - loss of everything on the dedicated disk;
  - Linux and Docker installed on that disk only;
  - `smartmontools`, `pciutils`, `hdparm` and `nvme-cli` installed, for read-only inspection (B4).

  Confirm it is a desktop (no battery), with no UPS between the outlet and the machine, and that nothing else of value runs on it.
- **Expected:** a dated, signed agreement naming the machine, the disk and the four tools.
- **Evidence:** the agreement; the machine's make, model and serial; a photograph of the power path.
- **Stop if:** there is no written agreement, or it leaves out an item above; the machine is a laptop; any other data is on the dedicated disk.

## 1a. Source package and native image build (B3)

**Package (on the Mac, from the reviewed checkout).** Do this only once the reviewed changes are committed: the package is the commit, not the working tree.
- **Preconditions:** `git status --short` in the harness worktree prints nothing; the commit is the one that was reviewed.
- **Action:**
  ```bash
  C=$(git rev-parse HEAD); OUT=<a new directory outside every repository>
  mkdir -p "$OUT/operator-docs"
  git archive --format=tar.gz --prefix=opspilot-p7-${C:0:12}/ -o "$OUT/opspilot-p7-${C:0:12}.tar.gz" "$C" \
    .dockerignore package.json package-lock.json apps/api apps/web/package.json prototype
  cp <main checkout>/docs/p7-physical-linux-test-plan.md "$OUT/operator-docs/"      # uncommitted by decision
  cd "$OUT" && echo "$C" > SOURCE-COMMIT
  shasum -a 256 opspilot-p7-*.tar.gz SOURCE-COMMIT operator-docs/* > SHA256SUMS && shasum -a 256 -c SHA256SUMS
  tar -tzf opspilot-p7-*.tar.gz | grep -Ei '(^|/)\.env|\.key$|\.pem$|(^|/)keys/|recorder-id\.json|volumes\.jsonl|/evidence/'
  ```
- **Expected:** every line of the check says `OK`; the last command prints **nothing**. `git archive` takes tracked files of that commit only, so no key, environment file, recorder directory or evidence can be in it.
- **Evidence:** `SHA256SUMS` and `SOURCE-COMMIT`, kept on the Mac as well.
- **Stop if:** the worktree is not clean; the last command prints a path.

**Verify and build (on the test machine, phase B).** Carry `$OUT` over the LAN (`scp`) or on removable media. No push.
- **Preconditions:** step 2; the machine has outbound access for the build.
- **Action:**
  ```bash
  cd <where the package was copied> && sha256sum -c SHA256SUMS
  tar -xzf opspilot-p7-*.tar.gz && cd opspilot-p7-*/              # this directory is <pkg>
  docker build -t opspilot-isolated-api:latest -f apps/api/Dockerfile .
  docker pull postgres:16-alpine
  docker image inspect -f '{{.Os}}/{{.Architecture}} {{.Id}}' opspilot-isolated-api:latest
  docker image inspect -f '{{.Os}}/{{.Architecture}} {{.Id}} {{index .RepoDigests 0}}' postgres:16-alpine
  uname -m
  ```
- **Expected:** every checksum line says `OK`. The build is the one the repository's Compose file defines for the API (context: the repository root; `apps/api/Dockerfile`). Both images report the machine's own architecture (`linux/amd64` on an `x86_64` machine).
- **Evidence:** the source commit, the package checksum, and for each image its architecture and id (and the PostgreSQL image's repository digest), under `<evidence>/host-preparation/`. **Four of these are given to `create-run` in step 13:** the commit in `SOURCE-COMMIT`, the checksum of the `.tar.gz` in `SHA256SUMS`, the harness image's id (`sha256:...`) and its architecture (`amd64` or `arm64`).
- **Stop if:** a checksum fails; the build fails; an image's architecture differs from the machine's; an image named `opspilot-isolated-api` was loaded or copied in from another machine.
- **What the recorder enforces from here on (qualifying run):** the harness source on the test machine must equal the recorder's own copy, file by file (one digest over every file the harness executes); the container's architecture must be the declared one; the declared commit, package checksum and image id are fixed in the run's record. A changed source file, on either host, refuses every start.
- **What it cannot enforce:** the image id (O4). Do not rebuild, pull, retag or edit anything after this step, and keep the package directory and both images until the independent review is complete.
- **Never done:** the package commands were tried on the Mac; the build from the package has not been run anywhere.

## 2. Linux distribution, kernel and filesystem (B5)

- **Preconditions:** step 1. Installing Ubuntu, Docker Engine and the four inspection tools is the operator's action on the dedicated machine, covered by the written permission; nothing else is installed.
- **Action (read-only):**
  ```bash
  cat /etc/os-release; uname -r; systemd-detect-virt
  docker version; docker compose version; docker info -f '{{.DockerRootDir}} {{.Driver}}'
  systemctl is-enabled docker; iptables --version
  sudo ufw status; timedatectl status
  command -v smartctl lspci hdparm nvme
  ```
- **Expected:**
  - Ubuntu 24.04 LTS; `systemd-detect-virt` prints `none`.
  - Kernel 5.5 or newer (record the actual version). The flush probe reads a counter older kernels do not have.
  - Docker Engine with Compose v2; `docker` is `enabled`, so the stack returns after a boot.
  - `iptables` present (the `nf_tables` variant is fine).
  - `ufw` reports `Status: inactive`. If it is active, record it; it may rewrite the chains the P7 rules use.
  - The clock is synchronised. The recorder rejects requests more than 5 minutes off.
  - All four tools are found.
- **Evidence:** the output, under `<evidence>/host-preparation/`.
- **Stop and request review if:** not Ubuntu 24.04 LTS; virtualised; kernel older than 5.5; Docker Desktop instead of Docker Engine; a tool is missing; the clock is not synchronised.

## 3. Dedicated test disk and volume identity (B5)

- **Preconditions:** step 2.
- **Action (read-only):**
  ```bash
  lsblk -o NAME,MODEL,SERIAL,ROTA,TRAN,SIZE,FSTYPE,MOUNTPOINTS
  lsblk -s -o NAME,TYPE,TRAN,MODEL
  findmnt -T "$(docker info -f '{{.DockerRootDir}}')" -o TARGET,SOURCE,FSTYPE,OPTIONS
  docker volume ls --filter label=com.docker.compose.project=opspilot-m16-p7
  docker volume ls --filter label=com.docker.compose.project=opspilot-m16-p7-smoke
  ```
- **Expected:**
  - Docker's data root is on the dedicated local SSD (`ROTA` 0), on local **ext4**. Both named volumes of each project live under it, so PostgreSQL's data and the journal are on ext4-backed storage, not on the container's overlay layer.
  - Mount options contain neither `nobarrier` nor `data=writeback`.
  - The physical device behind the filesystem is recorded. If LVM, dm-crypt or md sits between them, record the whole chain: the write-cache and FUA values that matter are the physical drive's.
  - Both volume listings are empty: neither project exists yet.
- **Evidence:** the output. The drive's model and serial are the disk's identity for the storage evidence.
- **Stop and request review if:** not ext4; a network filesystem or overlay; a forbidden mount option; the data root is not on the dedicated SSD; a volume of either project already exists.

## 4. Device write cache, FUA and flush evidence

- **Preconditions:** the smoke stack is up (step 11, first part), so a journal volume exists for the probe; step 6's first capture is done.
- **Action:** read, for the drive found in step 3:
  - `queue-<dev>.txt`: `write_cache` (`write back` or `write through`) and `fua` (`1` or `0`). In the JSON, `0` is `not-advertised`; `no` means advertised but not working, and is refused;
  - SATA: `hdparm-W-<dev>.txt`, and `hdparm-I-<dev>.txt` for the FLUSH CACHE commands. NVMe: `nvme-id-ctrl-<dev>.txt` (the `vwc` field), `nvme-vwc-<dev>.txt`;
  - `flush-probe.txt`: the flush count for that device before and after;
  - `kernel-storage-messages.txt`, `smart-<dev>.txt`, `lspci-storage.txt`, `lsblk-tree.txt`;
  - the vendor's datasheet for that exact model: flush and FUA semantics, power-loss protection.

  Copy `storage-evidence.template.json` outside `<pkg>` and fill every field from those files. The script only reads these values; it sets none.
- **Expected:** every field filled; `vendorFlushSemantics` is `yes` from a cited document. With a write-back cache: `flushSupported` and `flushesObserved` both `yes`. FUA `not-advertised` is acceptable only with observed flushes and the vendor document.
- **Evidence:** the filled JSON; the host-evidence directory with its `SHA256SUMS`; the vendor document and where it came from.
- **Stop if:** any field would be `unknown`; the flush count did not rise or reads `unavailable`; a tool's file says `missing`; no vendor document supports flush or FUA durability; FUA is advertised but does not work; write-through without FUA and without observed flushes. The qualifying run is then not created. Do not adjust a value, and do not change a drive setting, to pass.

## 5. PostgreSQL 16 durability settings and the actual `wal_sync_method`

- **Preconditions:** none to read the file; a running stack to read the values.
- **Action:** `compose.yml` starts `postgres:16-alpine` with `fsync=on`, `full_page_writes=on`, `synchronous_commit=on`. It is not edited. Read the live values (smoke stack; later the same without `smoke` for the qualifying stack):
  ```bash
  for s in fsync full_page_writes synchronous_commit wal_sync_method data_checksums server_version; do
    smoke exec -T db psql -qtA -U proto -d proto -c "SHOW $s"; done
  ```
- **Expected:** `on`, `on`, `on`; `wal_sync_method` as found (recorded, never set); `data_checksums` as found; a 16.x version. Preflight prints the same six under `facts.settings`.
- **Evidence:** the output for each project. These six values are bound by the readiness record.
- **Stop if:** any of the first three is not `on`; the version is not 16.

## 6. Host evidence collection and flush probe

- **Preconditions:** the stack named in the command is up; `<evidence>` exists.
- **Action:**
  ```bash
  # Phase D, under the smoke project (the storage JSON is filled from this one):
  sudo P7_PROJECT=opspilot-m16-p7-smoke P7_SMOKE_GENERATION=$P7_SMOKE_GENERATION P7_EVIDENCE_HOST=<evidence> ./host-evidence.sh <smoke-run> baseline --flush-probe
  # Phase E, before the smoke project is taken down (its database log goes with its containers):
  sudo P7_PROJECT=opspilot-m16-p7-smoke P7_SMOKE_GENERATION=$P7_SMOKE_GENERATION P7_EVIDENCE_HOST=<evidence> ./host-evidence.sh <smoke-run> final
  # Phase F, after the qualifying stack is up and before init:
  sudo P7_EVIDENCE_HOST=<evidence> ./host-evidence.sh <run> baseline --flush-probe
  ```
- **Expected:** `host evidence written to <evidence>/<run>/host/<label>`. It refuses to overwrite a label. The probe writes and deletes one small file beside the journal volume; nothing else is changed. `db-log.txt` holds the database log and ends with `exit 0`; `containers.txt` lists that project's three containers; `container-images.txt` gives the image id each container was created from. For the qualifying project that id must equal the one given to `create-run`, in the baseline and in every later capture. In phase F, `findmnt-pgdata.txt` and `findmnt-state.txt` name the **same source device and filesystem** as the storage JSON, and the flush count rises again.
- **Evidence:** each directory with its `SHA256SUMS`.
- **Stop if:** an image id in `container-images.txt` of the qualifying project differs from the declared one; `volume-state-mountpoint.txt` is empty or `flush-probe.txt` says `skipped` (wrong project name, or the environment was dropped by `sudo`); `db-log.txt` is empty or holds an error (do not take the smoke project down until the `final` capture has the log); in phase F the device or filesystem differs from the storage JSON. In that last case do not run `init`: nothing is used up yet, and a new run can be created with corrected evidence.
- **Why the storage evidence is taken under the smoke project:** `create-run` for the qualifying run needs the filled storage JSON, the JSON needs the flush probe, and the probe needs a journal volume. The smoke project's volumes are in the same Docker data root, so the evidence is taken there first and confirmed in phase F on the qualifying volumes.

## 7. Recorder directory creation and independent backup verification

**7a. Create (recorder host, phase B)**
- **Preconditions:** a host that is not on the switched outlet, with Node 22 or later and the reviewed harness; a **new** directory path outside any repository. Not the Mac's existing smoke recorder directory: it has no identity, can never hold a qualifying run, and is preserved untouched.
- **Action:**
  ```bash
  mkdir <recorder-dir>                     # must not exist yet
  node recorder.mjs serve --dir <recorder-dir> --host <recorder-ip> --port 8787 --new-directory     # leave running
  node recorder.mjs create-run --dir <recorder-dir> --new-directory --run <smoke-run> \
    --failure-model HARNESS-SMOKE --machine "<model, disk>"
  ```
  `--new-directory` is used on these two commands only. Every later command, including a restart of `serve`, omits it.
- **Expected:** `P7 recorder on <recorder-ip>:8787, storing in <recorder-dir>`; `create-run` prints the run id and the key file's path, never the key. `<recorder-dir>/recorder-id.json` now exists.
- **Evidence:** the two outputs.
- **Stop if:** `refused: --new-directory, but ... already holds a recorder` (wrong path); `history was removed. STOP` (the directory holds leftovers of another recorder); the directory is not new.
- **[REVIEW]** Allow port 8787 on the recorder host from the test machine only, and keep that host awake for the session. The harness does neither.
- **`recorder_busy`:** the server and the operator commands take one lock on the directory (`.recorder.lock`), so a decision is never made on a ledger another process is changing. A recorder command that answers `recorder_busy` changed nothing: run it again. Start only one `serve` per directory (a second one is refused), and avoid recorder commands in the seconds a cycle is being started (the harness repeats a start that was answered busy, and nothing else). If it keeps answering busy while no recorder command is running, stop and report; do not remove the lock file yourself.

**7b. Back up and verify (recorder host, phase E: after the rehearsal, before the qualifying `create-run`)**
- **Preconditions:** the smoke rehearsal is finished and nothing is talking to the recorder.
- **Action:**
  ```bash
  cp -a <recorder-dir> <backup>            # another disk or machine; local media; permissions kept; never a synced folder
  node recorder.mjs verify-dir --dir <recorder-dir> --backup <backup>
  ```
- **Expected:** exit 0, `"problems": []` for the directory and for the backup. No key is printed. `"sameFilesystem": false`. That value only rules out the same filesystem: confirm yourself that the copy is on another physical disk or machine.
- **Evidence:** the report; where the backup is kept.
- **Stop if:** exit 1; `not an independent copy` (the backup is the live directory or inside it); `"sameFilesystem": true` (the copy is on the same filesystem: move it to another disk and verify again); any later command says the directory is missing, empty or damaged, or answers `volume_registry_inconsistent` or `recorder_identity_missing`. Never copy the backup over the live directory; never create a new one; nothing resets or recreates the registry.

## 8. Firewall installation, exact rules and rollback

- **Preconditions:** steps 2 and 3; no P7 stack running yet (so the gateway never probes outward unprotected); a working ssh session from the operator's machine.
- **Action:**
  ```bash
  cd <harness>/firewall
  RECORDER_IP=<recorder-ip> RECORDER_PORT=8787 ./p7-firewall.sh print          # changes nothing
  sudo RECORDER_IP=<recorder-ip> RECORDER_PORT=8787 ./p7-firewall.sh apply     # keep the current ssh session open
  #   from the operator's machine, open a NEW ssh session; only if it works:
  sudo ./p7-firewall.sh confirm
  RECORDER_IP=<recorder-ip> RECORDER_PORT=8787 ./p7-firewall.sh unit | sudo tee /etc/systemd/system/p7-firewall.service
  sudo systemctl daemon-reload && sudo systemctl enable p7-firewall.service
  ```
- **Expected: `print` shows exactly these 16 lines,** with the recorder's address in the ninth:
  ```
  iptables -N P7-HOST
  iptables -A P7-HOST -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment p7-harness -j ACCEPT
  iptables -A P7-HOST -m comment --comment p7-harness -j DROP
  iptables -I INPUT 1 -i p7db0 -m comment --comment p7-harness -j P7-HOST
  iptables -I INPUT 1 -i p7gw0 -m comment --comment p7-harness -j P7-HOST
  iptables -I INPUT 1 -i p7eg0 -m comment --comment p7-harness -j P7-HOST
  iptables -N DOCKER-USER
  iptables -N P7-EGRESS
  iptables -A P7-EGRESS -p tcp -d <recorder-ip> --dport 8787 -m comment --comment p7-harness -j RETURN
  iptables -A P7-EGRESS -m comment --comment p7-harness -j DROP
  iptables -I DOCKER-USER 1 -i p7eg0 -m comment --comment p7-harness -j P7-EGRESS
  iptables -I DOCKER-USER 1 -i p7db0 ! -o p7db0 -m comment --comment p7-harness -j DROP
  iptables -I DOCKER-USER 1 -i p7gw0 ! -o p7gw0 -m comment --comment p7-harness -j DROP
  ip6tables -I INPUT 1 -i p7db0 -m comment --comment p7-harness -j DROP
  ip6tables -I INPUT 1 -i p7gw0 -m comment --comment p7-harness -j DROP
  ip6tables -I INPUT 1 -i p7eg0 -m comment --comment p7-harness -j DROP
  ```
  `apply` prints `applied. Open a NEW ssh session ...`; `confirm` prints `kept`. The rules match only the three P7 bridges, never the physical interface.
- **Rollback:**
  - Automatic: without `confirm`, the rules remove themselves after 180 seconds.
  - Manual: `sudo ./p7-firewall.sh remove`, then `sudo systemctl disable p7-firewall.service`. Disabling is what removes Docker's dependency on the unit; the unit file left behind does nothing.
  - The unit is required by `docker.service` and runs the script from its present path. If the unit fails, or `<pkg>` is moved, **Docker does not start at boot**. Run `sudo ./p7-firewall.sh status` and `systemctl status p7-firewall.service` to see why.
  - Once a readiness record exists, removing the rules makes every qualifying start fail the strict check. That is intended.
- **Evidence:** the `print` output, the `apply` and `confirm` output, the unit file's text, the time of each.
- **Stop if:** `print` differs from the list; the new ssh session fails (do not confirm; let it roll back); `confirm` says `nothing to confirm`; `ufw` is active and changes `INPUT` or `DOCKER-USER`.
- **Never observed:** these rules have only run against stub `iptables`. The first application is itself a test.

## 9. The nine real-host firewall checks

Check 3 is strict only in a `POWER-CUT` run, so the nine are run twice: **9a** during the rehearsal (what can be seen there), and **9b** in full under the qualifying project, after its stack is up and **before** the attestation and `init`. In 9a put `smoke` in place of `docker compose`. Step 11's reboot serves as check 9 for 9a.

| # | Command | Expected |
|---|---|---|
| 1 | `sudo ./firewall/p7-firewall.sh status` | Tagged rules under `INPUT`, `DOCKER-USER`, `P7-HOST`, `P7-EGRESS` |
| 2 | A new `ssh` session from the operator's machine | Connects as before |
| 3 | `docker compose exec -T harness node p7.mjs netcheck` | 9b: **exit 0 decides**, with `"strict": true`. The recorder is reachable through the gateway; every probe of a bridge address is `timeout` or an unreachable error, never `refused` or `connected`; the `host.docker.internal` probes show a name-resolution error (the name does not exist on native Linux, and strict mode accepts that); "bridge addresses discovered" is 2; every "gateway to ..." probe is blocked; the gateway self-check line and "gateway listeners bound to the internal address only" pass. 9a: `"strict": false`; read the strict result from step 12's preflight instead |
| 4 | `docker compose exec -T gateway node -e "require('net').connect({host:'1.1.1.1',port:443}).setTimeout(4000,()=>{console.log('timeout');process.exit(0)}).on('connect',()=>{console.log('CONNECTED');process.exit(1)}).on('error',e=>{console.log(e.code);process.exit(0)})"` | `timeout` |
| 5 | The same with `host:'<recorder-ip>',port:8787` | `CONNECTED` (exit 1 here means reachable, which is wanted) |
| 6 | The same with `host:'<recorder-ip>',port:22` | `timeout` |
| 7 | `docker compose exec -T harness node -e "require('net').connect({host:'db',port:5432}).on('connect',()=>{console.log('connected');process.exit(0)})"` | `connected` |
| 8 | `sudo ss -ltnp` | Nothing listens on 5432 on the host |
| 9 | After a reboot (the operator's action): `systemctl is-active p7-firewall.service`, then 1 and 3 again | `active`, and the same results, before anything else is run in that boot |

- **Preconditions:** step 8 confirmed; for 3 to 7 the stack of that phase is up.
- **Evidence:** the output of all nine, for 9a and 9b separately, with times, under `<evidence>/host-preparation/firewall/`. The netcheck itself is also saved in `<evidence>/<run>/netcheck/`.
- **Stop if:** check 3 exits non-zero in 9b; `refused` on a bridge address (the host answered); `CONNECTED` in 4 or 6; anything but `CONNECTED` in 5; the unit is not `active` after the reboot. Do not record the firewall attestation.
- **Never observed:** check 9 in 9b reboots the machine with the qualifying stack up and not yet initialised. `init` refuses a cluster past 64 MiB of WAL; a reboot of an empty cluster should stay far below that, but this has not been seen. A strict check takes about a minute with the rules applied, because every dropped probe waits for its timeout.

## 10. Manual cut procedure rehearsal, without physical power loss (B2)

**No power is cut.** The test machine stays on an outlet the plug does not switch. The smart plug is exercised with nothing, or a lamp, on it.

- **Preconditions:** the smoke stack is up and initialised (step 11, first part); the firewall is applied; step 12's first capture is taken.
- **Action, cycle 1 (the smart-plug path):**
  ```bash
  # Test machine: one process, one worker, NOT paced (no pattern, no throttle), to measure what this machine reaches.
  # 300/s only sizes the pool here; it is not a limit and not a measurement.
  smoke exec -T harness node p7.mjs run --cycle 1 --proc a --workers 1 --max-seconds 120 --rate 300
  # Recorder host, in another terminal:
  node recorder.mjs cut --dir <recorder-dir> --run <smoke-run> --cycle 1 --min-seconds 5 --max-seconds 60 \
    --command-json '["<plug command>", "<argument>", "..."]'          # [REVIEW] O2: the plug's own command
  ```
  Watch the plug switch, and note the time from a clock synchronised with the recorder. Then, because no power was lost:
  ```bash
  node recorder.mjs confirm-cut --dir <recorder-dir> --run <smoke-run> --cycle 1 --power-was-cut no \
    --attested-from <ISO time the plug switched> --evidence "rehearsal on the host: the plug switched with the machine on another outlet; no power was cut"
  ```
- **Action, cycle 2 (the manual path, with the burst pattern, after step 11's reboot and recovery):** `run --cycle 2 --proc a --workers 1 --max-seconds 120 --rate <a maximum burst rate below what cycle 1 measured> --burst-period 60 --burst-seconds 10 --quiet-rate <a quiet rate well below it, and at least 0.2>` (rehearsal values, O3), then `cut` **without** `--command-json`. At `*** CUT THE POWER NOW ***` go through the motions at the wall socket the machine is **not** on, note the time, and `confirm-cut --cycle 2 --power-was-cut no` with the same kind of evidence text.
- **Expected:** `cut` prints `cycle N: cut in M s`, then `cut command exited with 0` (cycle 1) or the prompt with the request time (cycle 2). The workload keeps running, because nothing was cut: it ends at the reboot in step 11 (cycle 1), or at the end of its planned time (cycle 2). In cycle 2 the claims must come in bursts: 10 seconds at no more than the maximum burst rate, then 50 seconds at no more than the quiet rate. `result.json` records the declared pattern under `sizing`; the measurement below shows what actually happened. Each cycle's verdict is INCONCLUSIVE, with `POWER_LOSS_NOT_CONFIRMED` among the reasons.
- **Measure both cycles (recorder host; read-only):**
  ```bash
  node recorder.mjs measure --dir <recorder-dir> --run <smoke-run> --cycle 1 > measure-cycle-1.json
  node recorder.mjs measure --dir <recorder-dir> --run <smoke-run> --cycle 2 > measure-cycle-2.json
  ```
  - **Cycle 1 (not paced):** `measured.averageClaimsPerSecond` and `measured.maximumClaimsInOneSecond` are what one worker reaches on this machine. `withinConfiguredLimits` is `null`: there was no limit. `configured.sizingRatePerWorker` (300) is not a measurement.
  - **Cycle 2 (paced):** `measured.workers` is 1 and `measured.processes` is 1. The windows starting at 0 s, 60 s and 120 s hold the bursts; the five after each hold the quiet claims. `measured.burstPeriods.claimsPerSecond` is at or below the maximum burst rate, `measured.quietPeriods.claimsPerSecond` at or below the quiet rate, and `withinConfiguredLimits` is `true`.
  - **Stop and report if** the bursts are not there, a window is over its limit (`windowsOverLimit`), or the burst rate is not clearly above the quiet rate: the qualifying series must not be the first place the pattern is observed.
- **Evidence:** the terminal output of `run`, `cut` and `confirm-cut`; both measurement reports; the noted times; a note of what the plug was connected to. Keep the plug's command out of the evidence if it carries a token: the recorder itself records only its exit status.
- **Timing:** issue `cut` within about a minute of starting the workload. The recorder refuses a cut that could come later than the 120 seconds the pool was sized for; that refusal is the sizing rule working, not a fault: let the cycle end, `check` and `recover` it, and start the next one.
- **Stop if:** `cut` is refused for any other reason; the plug command exits non-zero or the plug does not switch; the prompt never appears; the clocks disagree by more than a few seconds; **the test machine turns out to be on the switched outlet**.
- **What this is not:** a physical power-cut cycle, or validation of a physical cut. It shows that the operator sequence and the plug command work. The attestation in step 14 must say so.

## 11. Isolated smoke project: startup, execution, reboot and recovery

- **Preconditions:** steps 1a, 7a and 8; `<smoke-run>`'s key copied to `<key>` (`scp` or removable media), mode 0600.
- **Action, startup:**
  ```bash
  export P7_RUN=<smoke-run> P7_RECORDER_TARGET=<recorder-ip>:8787 P7_KEY_FILE_HOST=<key> P7_EVIDENCE_HOST=<evidence>
  docker volume ls -q --filter name=opspilot-m16-p7-smoke_     # must print nothing for this generation
  smoke up -d --wait
  docker volume inspect -f '{{.Name}} {{.CreatedAt}} {{ index .Labels "opspilot.p7.data" }} {{ index .Labels "opspilot.p7.smoke-generation" }}' \
    opspilot-m16-p7-smoke_pgdata_$P7_SMOKE_GENERATION opspilot-m16-p7-smoke_state_$P7_SMOKE_GENERATION
  docker volume ls --filter label=com.docker.compose.project=opspilot-m16-p7
  smoke exec -T harness node p7.mjs netcheck
  smoke exec -T harness node p7.mjs init
  # Where the gateway really listens (its own sockets, read inside the running container), and its two addresses:
  smoke logs gateway | tail -3
  smoke exec -T harness node -e "fetch('http://gateway:8788/').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.listeners)))"
  docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}' "$(smoke ps -q gateway)"
  docker port "$(smoke ps -q gateway)"
  timeout 3 bash -c '</dev/tcp/<the gateway egress address>/8788' && echo OPEN || echo closed
  ```
  Then steps 6 (baseline), 4, 5, 9a, 12 (first capture) and 10 (cycle 1).
- **Action, reboot and recovery,** after step 10's cycle 1. The reboot is the operator's action; it is an ordinary restart, not a power cut:
  ```bash
  sudo systemctl reboot
  # after the machine is back: cd <harness>, export P7_SMOKE_GENERATION and the four variables again, define smoke()
  systemctl is-active p7-firewall.service docker
  smoke ps -a
  smoke logs harness | tail -5
  smoke exec -T harness node p7.mjs check --cycle 1
  smoke exec -T harness node p7.mjs recover --cycle 1
  ```
  Then step 12 (second capture), step 10's cycle 2, and `check` and `recover` for cycle 2.
- **Expected:**
  - Both smoke volumes were created by this `up`, at this time, and print `disposable-harness-smoke` and the generation; the listing for `opspilot-m16-p7` is **empty**.
  - `netcheck` exits 0 with `"strict": false`; `init` prints `{"initialised": ...}`.
  - The gateway log says `forwarding <address>:8787` and `egress self-check on <address>:8788`; the listeners line shows both ports on that same address; that address is the one `docker inspect` gives for the `..._p7gw` network, not the `..._egress` one. `docker port` prints nothing (no port is published). The last command prints `closed`: nothing listens on the egress side.
  - After the reboot the three containers are running without any command from the operator, and the harness log shows `boot probe:` and `boot reported`.
  - `check` exits 3 (INCONCLUSIVE: a `HARNESS-SMOKE` run can never count). Exit 2 is a FAIL.
  - `recover` exits 0. Exit 4 means a claim was left one ahead: run it again with the `--clear-digest <digest>` it printed.
  - `result.json` under `<evidence>/<smoke-run>/cycle-0001*/` has `measuredRate`; the fuller report is `recorder.mjs measure` (step 10). With one unpaced worker (cycle 1) it is what this machine reaches: the figure the product owner needs to decide the maximum burst rate and the quiet rate (O3).
- **Evidence:** all output; `<evidence>/<smoke-run>/` whole.
- **Stop if:** a smoke volume of this generation existed before the `up`, or a container is on any other volume; the gateway container keeps restarting (its log then says it could not identify the internal interface: report it; the gateway never falls back to listening on every address); a listener is on `0.0.0.0` or on the egress address; the last command prints `OPEN`; a volume of `opspilot-m16-p7` exists; a smoke volume lacks the label; Compose offers to recreate a volume; `init` is refused; the stack does not return by itself; `check` exits 2 or 1; `recover` exits anything but 0 or 4.
- **Note:** `smoke-docker-desktop.sh` is not used on the host. It is written for Docker Desktop (`host.docker.internal`, container kills, a deliberate FAIL at the end).

## 12. Verification that readiness bindings survive reboot

- **Preconditions:** the smoke run is initialised; the firewall is applied. The first command runs **before** any reboot; the second after step 11's `recover`.
- **Action:**
  ```bash
  smoke exec -T harness node p7.mjs preflight --procs 1 --workers 1 --max-seconds 120 --rate <r> --burst-period 60 --burst-seconds 10 --quiet-rate <q> > <evidence>/host-preparation/preflight-smoke-before-reboot.json
  # ... step 10 cycle 1, reboot, check, recover (step 11) ...
  smoke exec -T harness node p7.mjs preflight --procs 1 --workers 1 --max-seconds 120 --rate <r> --burst-period 60 --burst-seconds 10 --quiet-rate <q> > <evidence>/host-preparation/preflight-smoke-after-reboot.json
  ```
  Use the same rehearsal values for `<r>` and `<q>` in both (any pair with `<q>` below `<r>` and at least 0.2; they are not the qualifying values). Compare the `binding.test` object in the two files, field by field (it is about 30 lines; read both side by side).
- **Expected:**
  - Both exit 6 and say `BLOCKED` (a smoke run can never be ready). That is correct here.
  - `binding.test` is **identical**: `pgSystemId`, `journal.markerSha256`, `journal.installationId`, the six PostgreSQL settings and their digest, `firewall.bridges` (two addresses), `firewall.probes`, `firewall.digest`, the workload with its burst pattern, `source` (the harness source digest) and `runtime` (architecture, Node version, and the fingerprint of the image's Node binary and installed dependencies).
  - `firewall.strict` and `firewall.passed` are both `true`, and `facts.netcheck.failed` is empty. This is the first strict network result on a real host; it includes "gateway listeners bound to the internal address only".
  - `source.treeSha256` equals the digest of the recorder host's own copy: `node -e "import('./lib/source.mjs').then(m=>console.log(m.sourceDigest('..')))"` in `<harness>` there.
- **Also:** each smoke cycle start stores what it reported. On the recorder host, `grep -c bindingNoted <recorder-dir>/runs/<smoke-run>/events.jsonl` should count 2 after cycle 2. Their workload part varies with the measured rate; the rest should match.
- **Evidence:** both files; the comparison.
- **Stop if:** any bound field differs across the reboot (bridge addresses and the probe digest are the likely ones); `firewall.passed` is `false`. A value that changes at every boot would make every qualifying cycle after the first cut `readiness_stale`. Report it; do not create the qualifying run.
- **Each preflight** makes the gateway try its fixed list of destinations. With the firewall applied they are dropped on the machine.

## 13. Fresh qualifying volume and cluster

- **Preconditions:** steps 4, 7b and 12 are done; the `final` smoke host evidence is taken and has the database log (step 6); the running `serve` process was started from the reviewed checkout, and no file of it has changed since (the recorder checks the files on its disk, not the code already loaded: if anything changed, restart `serve` first).
- **Action:**
  ```bash
  # Recorder host:
  git status --short; git rev-parse HEAD        # in the reviewed checkout: nothing changed, and the commit of SOURCE-COMMIT
  node recorder.mjs create-run --dir <recorder-dir> --run <run> --failure-model POWER-CUT \
    --storage-json <filled storage JSON> --machine "<model, disk>" \
    --source-commit <40 hex, from SOURCE-COMMIT> --package-sha256 <64 hex, the .tar.gz line of SHA256SUMS> \
    --package <the opspilot-p7-....tar.gz itself, on the recorder host> \
    --image-id <sha256:..., from step 1a> --image-arch <amd64|arm64>
  # copy <recorder-dir>/keys/<run>.key to the test machine, mode 0600

  # Test machine. Free the bridge names: `stop` alone does not, because the networks keep them.
  # The script removes the stopped smoke containers and the smoke networks only. It cannot remove a volume.
  smoke stop
  ./smoke-containers-down.sh                                   # dry run: read what it lists
  ./smoke-containers-down.sh --confirm opspilot-m16-p7-smoke
  docker volume ls --filter label=com.docker.compose.project=opspilot-m16-p7-smoke     # both of this generation still listed
  docker volume ls --filter label=com.docker.compose.project=opspilot-m16-p7           # must be empty
  export P7_RUN=<run> P7_KEY_FILE_HOST=<key of the qualifying run>      # RECORDER_TARGET and EVIDENCE_HOST as before
  docker compose up -d --wait                                           # in <harness>: the project opspilot-m16-p7
  docker volume inspect -f '{{.Name}} {{.CreatedAt}} {{ index .Labels "opspilot.p7.data" }}' opspilot-m16-p7_pgdata opspilot-m16-p7_state
  docker compose exec -T db psql -qtA -U proto -d proto -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'"
  docker compose exec -T harness ls -A /state
  ```
- **Expected:** `git status --short` prints nothing for `prototype/`, and the commit is the packaged one. `create-run` reads the package itself: it refuses, and creates nothing, unless the file's SHA-256 is the declared one, the commit `git archive` embedded in it is the declared one, and the harness source in it is exactly the source this recorder host is running. Then it prints the run id and the key file's path. `smoke-containers-down.sh` lists three containers and three networks, removes exactly those, and ends with every smoke volume "still present, unchanged". The two qualifying volumes are created by this `up`, at this time, with **no** `opspilot.p7.data` label, so `smoke-teardown.sh` can never accept them. The relation count is `0`, and `/state` is empty.
- **Evidence:** all output; then step 6's phase F baseline.
- **Stop if:** `smoke-containers-down.sh` refuses, or ends with `STOP` (exit 3); `create-run` is refused (it lists every reason); a qualifying volume existed before the `up`; either volume carries the disposable label; the database or `/state` is not empty; Compose offers to recreate a volume; a smoke volume is gone.
- **From here on:** the qualifying volumes are never removed or recreated. Do not run `docker compose down` on this project: recreated networks may get other addresses, which the readiness record binds. No other run may claim volumes on this recorder, and the smoke project is not started again.

## 14. Required operator attestations

- **Preconditions:** each statement is true on this machine; step 9b passed with the strict check; `init` has **not** been run yet.
- **Action (recorder host), each exactly once:**
  ```bash
  node recorder.mjs attest --dir <recorder-dir> --run <run> --item firewall-verified-on-host \
    --evidence "<the nine checks, when, where the output is>"
  node recorder.mjs attest --dir <recorder-dir> --run <run> --item manual-cut-rehearsed-on-host \
    --evidence "<operator sequence and plug procedure rehearsed, when, where the output is; no power was cut>"
  node recorder.mjs attest --dir <recorder-dir> --run <run> --item host-evidence-reviewed \
    --evidence "<which host-evidence directories, the storage JSON, the vendor document, when>"
  ```
- **Expected:** `recorded operator attestation: <item>` three times. The text is cut at 500 characters, is stored as the operator's statement, and is bound by the readiness record.
- **Evidence:** the three outputs and the exact texts.
- **Stop if:** a statement is not true. Do not attest it. The rehearsal text must not say or imply that a physical cut was validated. Once the readiness record exists (step 15), `attest` is refused for that run: what was attested is part of the record, and the record is never replaced.

## 15. End-to-end preflight and recorder confirmation of `READY_FOR_OPERATOR_REVIEW`

- **Preconditions:** steps 13, 9b and 14; the one-worker measurement of step 10; the product owner's decision on the workload (O3).
- **The workload must be decided first (O3).** One process, one worker, and four numbers from the product owner: the maximum burst rate `R`, the burst seconds and period, and the quiet rate `Q`. The harness enforces `R` and `Q` when it runs, sizes the pool from the same numbers, and the recorder binds them all.
- **Sizing check, on paper:** with `--max-seconds 660` and 10 burst seconds in every 60 there are 110 burst seconds and 550 quiet seconds, so the pool is `(R x 110 + Q x 550) x 2`, and it must not exceed 1,000,000. That inequality is only the outer limit of what the clearance was validated for; **it is not a recommended rate, and no rate near it is approved.** `R` should also be at or below what step 10 measured for one worker, or the bursts will simply run at the machine's own speed. **If the decided workload does not fit, stop and report.** Do not change a number to make it fit, and do not add workers.
- **Action:**
  ```bash
  # Test machine:
  docker compose exec -T harness node p7.mjs init
  docker compose exec -T harness node p7.mjs preflight --procs 1 --workers 1 --max-seconds 660 --rate <R, the decided maximum burst rate> \
    --burst-period <decided> --burst-seconds <decided> --quiet-rate <Q, decided> \
    > <evidence>/host-preparation/preflight-<run>.json; echo "exit $?"
  # Recorder host:
  node recorder.mjs status --dir <recorder-dir> --run <run>
  node recorder.mjs verify-dir --dir <recorder-dir> --backup <backup> --allow-growth
  ```
  **The first preflight that reads `READY_FOR_OPERATOR_REVIEW` is final.** Its record is never replaced: the same configuration again is confirmed (`"alreadyRecorded": true`), and any other is refused (`readiness_already_recorded: <what differs>`). Check every flag before pressing enter. A preflight that reads `BLOCKED` records nothing and may be repeated.
- **Expected:**
  - `init` prints `{"initialised": ..., "pgSystemId": ..., "settings": ...}`. `<evidence>/<run>/init/initial-empty-state-*.json` exists.
  - Preflight exits 0. The file has `"status": "READY_FOR_OPERATOR_REVIEW"`, `"reasons": []`, and `"readiness": { "recorded": true, "digest": "<64 hex>" }`.
  - `status` shows `readiness.digest` **equal** to that digest; `readiness.workload` with `"procs": 1, "workers": 1`, the rate, window and pool given, and the decided `ratePerWorker` (the maximum burst rate), `burstPeriodSeconds`, `burstSeconds` and `quietRate`; three attestations; `cyclesStarted: 0`; `stopped: null`.
  - `verify-dir` exits 0: history only grew.
- **Evidence:** the preflight file; the `status` output; the `verify-dir` report; a new backup of `<recorder-dir>`.
- **Stop if:** preflight exits 6 (`BLOCKED`; every reason is listed; fix nothing by weakening a check); `recorded` is `false`; the digests differ; the recorded workload is not the one intended (it cannot be corrected: report it); `source_differs_from_the_recorder` or `image_architecture_differs_from_declared` (the two hosts do not hold the same code, or the image is not the declared one); `verify-dir` exits 1.
- **If `init` fails (B6, fail-stop):**
  1. **Stop. Do not run `init` again,** on this run or any other, and do not remove, recreate or reset anything: both volumes, the containers, `<evidence>/<run>/` and the recorder directory stay exactly as they are.
  2. Save the output of the failed command. On the recorder host, close the run. Its id is never used again:
     ```bash
     node recorder.mjs abandon --dir <recorder-dir> --run <run> --reason "<what failed, when, where the output is kept>"
     ```
     It writes a stop marker and a note in that run's record and touches nothing else: no volume, no journal, no registry line, no evidence, no Docker command. The run can no longer claim, initialise, be made ready, start a cycle or be continued.
  3. Only then see whether the volumes were claimed (a stopped run can no longer claim, so the count is final): `grep -c volume_claimed <recorder-dir>/runs/<run>/events.jsonl`.
  4. What follows:
     - **The count is 1, or anything about the outcome is uncertain: treat the volumes as claimed.** All state is preserved and **the qualifying session stops.** A new qualifying attempt needs investigation and the product owner's separate authorisation. The volumes are not deleted, reset or reused, and no other Compose project name is used to get around them.
     - **The count is 0 and the command said `init refused: ...`:** nothing was created and nothing was claimed. After the product owner's review, a **new** run id may be created (step 13's `create-run`, a new key, the three attestations again). The recorder accepts the volumes for it only if the database has no relations, the journal volume has no entries and the cluster is still new; otherwise it refuses, and the case above applies.
  5. Take host evidence (`sudo P7_EVIDENCE_HOST=<evidence> ./host-evidence.sh <run> init-failed`) and a new backup of `<recorder-dir>`, and report to the product owner. **The session stops here in both cases** until that review.
- **Then stop.** Do not run `p7.mjs run`, `recorder.mjs cut`, or anything that cuts power. The 20 physical power-cut cycles need the product owner's separate, explicit authorisation.

## 16. Stop conditions and evidence preservation

**Stop at once, whatever the step, if:**
- a command would remove or recreate a volume, or Compose offers to;
- a volume of `opspilot-m16-p7` appears before step 13, or anything touches the default `opspilot` project;
- the recorder directory is missing, empty, damaged, replaced or inconsistent;
- a key appears in a terminal, a log or a file under `<evidence>`;
- a firewall check gives any result other than the expected one;
- any command says `a journal write failed earlier` or `JOURNAL_WRITE_FAILED_EARLIER`, or a file `journal-write-failed.json` exists in the journal volume: a journal write or sync failed. Nothing more is written to that journal, by design. Do not remove the file, do not repeat the command to get past it, and do not continue the run;
- the host does not meet the baseline of steps 2 and 3;
- a drive error, an unusual noise or a burning smell;
- the owner withdraws permission.

**On stopping:** leave the stack, the volumes, the firewall and the recorder as they are; note the time and the last command; report to the product owner the same day. P7 stays NOT TESTED.

**Preserve, unchanged, until the independent review is complete:**
- `<recorder-dir>` and every backup of it (they contain the run keys: local media only);
- `<evidence>` whole, including `host-preparation/` and the rehearsal's evidence;
- every volume: the smoke volumes of this generation (`opspilot-m16-p7-smoke_pgdata_<generation>`, `..._state_<generation>`) and the qualifying volumes `opspilot-m16-p7_pgdata`, `_state`;
- the filled storage JSON, the vendor document, the written permission;
- the source package with its `SHA256SUMS` and `SOURCE-COMMIT`, and the recorded image ids.

**Manifest (test machine),** written outside `<evidence>` so it does not list itself:
```bash
(cd <evidence> && find . -type f -print0 | sort -z | xargs -0 sha256sum) > <evidence>-manifest-$(date +%Y%m%dT%H%M%S).sha256
```

**What reaching the end means:** the machine, storage evidence, firewall, recorder and configuration were prepared and recorded, and the recorder holds a readiness record for exactly that configuration. It is not a durability result, not a physical power-cut cycle, and not approval. Starting the 20 cycles is a separate decision.
