# REA on one VM

Run REA's products on one rented VM: a first-boot setup for Ubuntu 24.04,
sized for a Hetzner Cloud CPX32 (4 shared AMD vCPUs, 8 GB of memory,
160 GB of disk), and the pipeline from the MCP Trust Index to Proof Swarm's
plan. It is a recipe for a fresh machine of your own, not REA's installer:
it installs what the pipeline needs and changes nothing else.

| File              | What it does                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cloud-init.yaml` | First boot: adds the `rea` user, clones this repository and runs `bootstrap.sh`                                  |
| `bootstrap.sh`    | Swap, Node.js as `.nvmrc` pins it, the locked dependencies, REA's build and a smoke test; run again to update    |
| `node-sha256.txt` | The Node.js tarballs' checksums, from the release's signed `SHASUMS256.txt`                                      |
| `pipeline.sh`     | Fetch the 40 servers, map them with Landscape, plan Proof Swarm's run with REA's facts; records each step's cost |
| `swarm-args.mjs`  | Turns a Landscape map into Proof Swarm's workflow args: every unknown tool-reach cell                            |
| `measure.mjs`     | Runs a command and records its wall time and peak memory, of the process family and of its largest process       |

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
SSH; a Hetzner firewall that allows only inbound SSH costs nothing. Delete
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
fast-forwards the checkout and rebuilds, and leaves the rest as it is.

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

The agents are not part of the VM's setup. To run them there, install
Claude Code as its documentation describes, sign in, and ask it to run
`products/proof-swarm/workflows/tool-reach.workflow.js` with
`~/rea-work/planned.json`; then `proof-swarm collect` accepts the answers
(`products/proof-swarm/README.md`). The agents read the packages through a
hosted model, so everything they read goes to the model's provider.

## Measured

MEASURED_PLACEHOLDER

## Modal or Vast.ai

MODAL_SECTION_PLACEHOLDER
