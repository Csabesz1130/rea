# REA on one VM

Run REA's products on one rented VM: a first-boot setup for Ubuntu 24.04,
sized for a Hetzner Cloud CPX32 (4 shared AMD vCPUs, 8 GB of memory,
160 GB of disk), and the pipeline from the MCP Trust Index to Proof Swarm's
plan. It is a recipe for a fresh machine of your own, not REA's installer:
it installs what the pipeline needs and changes nothing else.

| File                  | What it does                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cloud-init.yaml`     | First boot: adds the `rea` user, clones this repository and runs `bootstrap.sh`                                  |
| `bootstrap.sh`        | Swap, Node.js as `.nvmrc` pins it, the locked dependencies, REA's build and a smoke test; run again to update    |
| `node-sha256.txt`     | The Node.js tarballs' checksums, from the release's signed `SHASUMS256.txt`                                      |
| `pipeline.sh`         | Fetch the 40 servers, map them with Landscape, plan Proof Swarm's run with REA's facts; records each step's cost |
| `swarm-args.mjs`      | Turns a Landscape map into Proof Swarm's workflow args: every unknown tool-reach cell                            |
| `measure.mjs`         | Runs a command and records its wall time and peak memory, of the process family and of its largest process       |
| `agent-settings.json` | A Claude Code permission policy for the agents, if they run on the VM (untested; see Agents)                     |

## Create the server

With the [hcloud CLI](https://github.com/hetznercloud/cli) and a project
token in `HCLOUD_TOKEN`:

```bash
hcloud ssh-key create --name me --public-key-from-file ~/.ssh/id_ed25519.pub
hcloud server create --name rea-1 --type cpx32 --image ubuntu-24.04 \
  --location fsn1 --ssh-key me --user-data-from-file products/vm/cloud-init.yaml
ssh root@<address> cloud-init status --wait     # returns when bootstrap.sh is done
```

The flags are hcloud's own (`internal/cmd/server/create.go`), but these
commands were not run here: this container has no Hetzner account. The
Cloud API takes the same file as `user_data` in `POST /v1/servers`. Edit
the branch in `cloud-init.yaml` to run another one; the repository is
public, so the clone needs no credentials. Nothing on the VM listens but
SSH; a Hetzner Cloud firewall that allows only inbound SSH keeps it so. Delete
the server when the run is done (`hcloud server delete rea-1`): it is
billed by the hour until then.

## What first boot does

`cloud-init.yaml` installs git, curl, xz-utils and CA certificates, adds
the user `rea`, clones the branch into `/home/rea/rea` and runs
`bootstrap.sh` as root, logging to `/var/log/rea-bootstrap.log`.
`bootstrap.sh` then:

- adds a 4 GB swap file when the VM has none, after backing up
  `/etc/fstab`;
- copies root's SSH keys to `rea` when `rea` has none, so `ssh rea@…` works;
- installs Node.js 24.18.0, as `.nvmrc` pins it, into `/opt/node-v24.18.0`,
  after checking the tarball against `node-sha256.txt`. Those checksums
  come from the release's `SHASUMS256.txt`, whose signature was verified
  with the release key C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C (Richard
  Lau, one of the releasers Node.js's README lists). Its npm, 11.16.0, is
  the one `package.json` names. Nothing else on the VM is changed;
- runs `npm ci` and `npm run build:cached` as `rea`;
- maps three checked-in products with Landscape as a smoke test, which
  fails unless REA analyzed each one.

Each step checks first, so running `bootstrap.sh` again as root
fast-forwards the checkout, reinstalls the dependencies only when the
lockfile or Node.js changed, rebuilds, and leaves the rest as it is.

## Run the pipeline

```bash
ssh rea@<address>
nohup rea/products/vm/pipeline.sh > pipeline.log 2>&1 &
```

`pipeline.sh` runs three steps, each reusing the one before's output, and
takes `fetch`, `map` or `plan` to run one:

1. **fetch** downloads the 40 most-downloaded MCP servers on npm and checks
   each tarball against the integrity pinned in
   `products/landscape/demo/packages.json`. Nothing downloaded is run.
2. **map** reads them with REA through Landscape, two at a time, into
   `~/rea-work/map/report.html`: the MCP Trust Index.
3. **plan** turns every server whose "An MCP tool reaches process
   execution" cell is unknown into Proof Swarm's workflow args
   (`swarm-args.json`) and runs `proof-swarm plan --rea`
   (`planned.json`): the packages level 0 settles with REA's facts, and the
   rest with their sketches for agents.

Every step appends its wall time, CPU time and peak memory to
`~/rea-work/costs.tsv`. `WORK`, `JOBS`, `HEAP_MB` (the Node heap for the
map and the plan, 6144 by default), `BATCH_SIZE` and `CALIBRATE` change
the defaults; `pipeline.sh` names them. Copy the results back with
`scp -r rea@<address>:rea-work/map ./map`.

## Agents

The agents are not part of the VM's setup, and nothing in this section was
run here: it follows Claude Code's documentation (permissions, sandboxing,
headless mode, workflows, authentication) as of October 2026. The agents
read the packages through a hosted model, so everything they read goes to
the model's provider, and permission rules limit what they can do, not
what the code they read can talk them into.

1. Install Claude Code as its documentation describes, and `bubblewrap`
   and `socat`, which its Linux sandbox needs.
2. Authenticate without putting a secret in `cloud-init.yaml`, whose user
   data stays readable from inside the VM: run `claude setup-token` on
   your own machine and set the token it prints as `CLAUDE_CODE_OAUTH_TOKEN`
   in your SSH session, or set `ANTHROPIC_API_KEY`.
3. As `rea`, from the checkout, run the workflow with the policy in
   `agent-settings.json` (`--permission-prompts` needs Claude Code 2.1.259
   or later), then collect the answers:

```bash
cd ~/rea
claude -p "Run the workflow products/proof-swarm/workflows/tool-reach.workflow.js with the args in ~/rea-work/planned.json, and save its return value as JSON to ~/rea-work/swarm-result.json." \
  --settings products/vm/agent-settings.json \
  --permission-mode dontAsk --permission-prompts none \
  --output-format stream-json --verbose > ~/rea-work/swarm.jsonl
node products/proof-swarm/bin/proof-swarm.mjs collect \
  ~/rea-work/planned.json ~/rea-work/swarm-result.json > ~/rea-work/collect.json
```

`agent-settings.json` lets the agents read `~/rea-work`, write claim files
and the result there, run `proof-swarm` and start the workflow; in
`dontAsk` mode anything else that would need approval is refused, so they
cannot run, install or fetch what they read. WebFetch, WebSearch and
Monitor are denied, and Bash runs in the sandbox with no network. Its
paths assume the defaults (`/home/rea/rea`, `~/rea-work`). Before trusting
a run, check the first `system/init` event in `swarm.jsonl`: its tools
should not include WebFetch, WebSearch or Monitor. A project's own
`.claude/settings.json` does not grant permissions to `claude -p` in a
folder you never trusted, which is why the policy comes in with
`--settings`.

## Measured

Rehearsed in an Ubuntu 24.04.5 container with 4 vCPUs (Intel Xeon at
2.1 GHz), the same count as a CPX32, whose shared AMD vCPUs were not
measured. The pipeline ran inside a 7 GiB memory cgroup with swap
disallowed: less than a CPX32's 8 GB and the 4 GB of swap `bootstrap.sh`
adds. One run each unless a row says otherwise; the first boot's downloads
came through this container's network, not Hetzner's:

| Step                                                    | Wall     | CPU, user + system | Peak memory, process family / largest process |
| ------------------------------------------------------- | -------- | ------------------ | --------------------------------------------- |
| `bootstrap.sh` at first boot, as `rea`, empty npm cache | 37 s     | 81 s               | 3.2 / 2.9 GB                                  |
| `bootstrap.sh` again, nothing changed                   | 4.4 s    | 8.8 s              |                                               |
| `fetch`: 40 packages, two runs                          | 36–49 s  | 27–30 s            | 0.28 / 0.21 GB                                |
| `map`: 40 packages, 2 at a time, 6 GB heap              | 25.4 min | 59 min             | 6.4 / 3.0 GB                                  |
| `plan --rea`: 24 packages                               | 13 s     | 16.5 s             | 0.98 / 0.58 GB                                |

The map stayed under the limit, with no process killed for memory. It
exits with status 1 because REA's analysis of @next-ai-drawio/mcp-server
runs past REA's 300-second timeout, as it did in the first index run,
which had 16 GB, no limit and an 8 GB heap and peaked at 5.3 GB. Its 24
unknown tool-reach cells are the same 24 the first swarm run took; level 0
settles n8n-mcp with REA's facts and sends 23 packages to agents in 8
batches. A run leaves 5.9 GB in `~/rea-work`, nearly all of it REA's
Evidence.

## Modal or Vast.ai

Not for this pipeline. Every step runs on CPUs, and it fit in less memory
than a CPX32 has. Vast.ai rents GPUs, which no step uses; it would matter
only to run a model yourself in place of the hosted one the agents use.
Modal runs containers that bill CPU and memory by the second, which pays
when one VM is too slow or too small:

- **More packages.** The map took about 38 s per package on average, two
  at a time on 4 vCPUs (the largest packages take most of it), so one VM
  like this maps about 95 an hour. For a few hundred or more,
  split the package list across several VMs or containers, one map each,
  and run `swarm-args.mjs` on each map: Proof Swarm's batches are
  independent, so their args combine.
- **Larger packages.** REA's deep depth, or a heap above 6 GB, can need
  more than 8 GB of memory (not measured here): a larger VM, or a
  container sized for it.

No Modal or Vast.ai code is included, and nothing here was run on either.
