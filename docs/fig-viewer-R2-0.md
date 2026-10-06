# fig-viewer R2-0: isolated loading and hello probe

This stage verifies the installed 0.2.0-rc.2 host/client contract. It does not implement a figure viewer, sidecar exporter, production result parser, or redraw workflow. The package version remains 0.6.43 and no release was published.

## Host and client contract

`exports['./client']` remains the single zero-build classic browser factory. The manifest now requests `ui-renderer`, settings, conversation, chat, sidebar-right, resources, and workspace-files packages. The removed `dsh-client-runtime` dependency is absent from the inspected installation. The supported acceptance target is 0.2.0-rc.2; legacy hosts need a separately tested adapter.

The factory requires the `slots`, `uiConversation`, `sidebarRight`, `sidebarRightTabs`, and `resources` services. The hello adapter checks its used methods before registering anything. Package dependencies in `dsh.client.inject`, service dependencies in `exports.inject`, and CJS module edges in `dsh.client.external` have distinct roles. The installed module cycle check orders `external` edges; treating package `inject` edges as a CJS dependency DAG is incorrect.

The developer probe requires `?figviewHello=1` when the factory mounts. First visit the carrier's printed token URL to authenticate, then navigate to `http://127.0.0.1:3187/?figviewHello=1`: the token exchange redirects to the bare directory. The card only renders in the explicit `figview-r2-hello` test session. Normal URLs retain the existing BioGenie settings contribution without registering the hello provider or tab.

| Interface | R2-0 implementation | Follow-up boundary |
| --- | --- | --- |
| Chat entry | List entry `bio-figure-hello` in `conversation.chat.turnTail` | R2-2 must discover real figure results and preserve the owning session |
| Resource navigation | `sidebarRight.openResource(dsh-resource://bio-figure/session/figview-r2-hello/hello)` | Real addresses and immutable revisions remain to be specified |
| Sidebar metadata | definition id `bio-figure-viewer`, kind `bio-figure` | `sidebar.right.pane.tab` renderer key is the definition **id**, not kind |
| Provider | `resources.register({protocol:'bio-figure', open})`, async frames | Fixed fixture only; other addresses fail with `figview/hello-only` |
| Resource hook | `useTabInfo().tab.contentId` → `useResource(address)` | R2-2 must implement workspace file, schema/hash, size and cancellation checks |
| Data | Three fixture rows with `fixture:true` | This is not the R2-1 sidecar schema |

## Acceptance evidence and limits

The installed runtime was copied from `D:/Product/AI/DeepSeek Harness/resources/app.asar` into `F:/A_longriverplan/plot-quality/figview-R2/runtime/`. The carrier used a copied bundled Node 24.18.1, a separate `DSH_HOME`, profile `figview-r2`, loopback port 3187 and `--no-open`. No second Electron instance was launched. Python warm-up was disabled; the fixture creates a session and appends a completed turn without prompting a model.

Real browser screenshots, DOM, boot graph, process and port records are under `F:/A_longriverplan/plot-quality/figview-R2/`. `hello-gate-before-main.json` proves the original repository was still clean at the first successful UI gate and its active-profile snapshot had zero changes. `hello-final-verification.json` proves the final main client, isolated copy and installed client have identical SHA-256, both UI contributions are visible, seven dependency packages are present, the provider is live with three rows, and slot error markers are absent.

Stopped uninstall and browser reboot passed: the installed package and its boot entry disappear, and hello cards/provider frames are absent. This does not claim live hot-unload coverage. The isolated home and caches were then deleted and port 3187 stopped listening. Sources, runtime copies and evidence remain available for a new run.

The full-window active-profile zero-change gate is **not established**. At the final snapshot, a separate desktop plugin-manager operation log `operation-XKjozw/pnpm.log` records removal of `dsh-plugin-fig-gallery`; the active manifest, lockfiles and root config changed after the first zero-difference gate. The experiment only installed/uninstalled the genie copy under F, and did not restore or alter those active files. See `active-profile-diff.json` and `active-concurrent-operation.log`. Treat the overall R2-0 acceptance as pending this concurrent-state audit; do not replace the final snapshot with the earlier passing one.

## Verification and restart

Run from this repository:

```powershell
node --check lib/client.js
node test/fig-viewer-hello.mjs
node test/domain-overview-ui.mjs
node test/domain-overview.mjs
node scripts/test-doc-counts.mjs
git diff --check
```

The factory/adapter test has 11 checks and does not substitute for real UI acceptance. The existing UI regression, six domain-overview tests and 28 documentation-count checks also passed. The complete Python/tool bench was not run for this client-only change.

The full operation manual is `F:/A_longriverplan/plot-quality/figview-R2-0-隔离手册.md`. To reinstall and restart retained experiment materials:

```powershell
python -B F:/A_longriverplan/plot-quality/figview-R2/install-hello.py
& F:/A_longriverplan/plot-quality/figview-R2/start.ps1
Get-Content -Encoding UTF8 F:/A_longriverplan/plot-quality/figview-R2/carrier.stdout.log
# Authenticate using the printed URL, then open /?figviewHello=1.
# Stop immediately after verification:
& F:/A_longriverplan/plot-quality/figview-R2/stop.ps1
& F:/A_longriverplan/plot-quality/figview-R2/uninstall.ps1
& F:/A_longriverplan/plot-quality/figview-R2/cleanup-state.ps1
```
