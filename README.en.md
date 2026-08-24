# 🧬 dsh-bio-genie

<div align="center">

[中文](README.md) | **English**

</div>

**Wish-style bioinformatics analysis plugin for DeepSeek Harness (dsh)**

> **dsh bio analysis** · **dsh biology analysis** · **deepseek harness bioinformatics** · Biopython · sequence analysis · genomics
>
> Speak plainly, get results. Users describe their bioinformatics needs in natural language, and the dsh agent performs the analysis automatically.

**Install and go** — no Python or Biopython installation required. The plugin bootstraps a fully isolated Python environment on first run.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🪄 **Wish-style Analysis (Wish Coding)** | Plain language in, results out: *"What's the GC content and EcoRI cut sites of this sequence?"* |
| 🧩 **Full Coverage** | The `bio_python` executor runs arbitrary Biopython code (alignment, PDB, Phylo, motif, BLAST…), backed by 21 domain/research skill recipes |
| ⚡ **High-Frequency Semantic Tools** | 39 fixed-parameter tools (GC content, translation, restriction enzymes, k-mer, file IO, BLAST, multiple sequence alignment, phylogenetic trees, Entrez, pathway enrichment, PubMed literature, reference genome, publication-grade plotting, machine learning, DNA design, Primer3 primers/multi-constraint DNA optimization/clone simulation, differential expression/GSEA) + 4 executor/meta tools (bio_python / bio_env / bio_log / bio_memory) — token-efficient, stable output, validated arguments |
| 📦 **Zero Installation** | Automatically downloads an isolated Python environment (uv + venv + Biopython) to `$DSH_HOME/dsh-bio-genie/`, no system pollution |
| 🇨🇳 **China-Network Ready** | Auto network adaptation: official sources by default, automatic switch to domestic mirrors on any failure (uv→Tsinghua PyPI, CPython→npmmirror, PyPI packages→Tsinghua), zero configuration required |
| 🛡️ **Environment Isolation** | Python subprocesses run in `-I` (isolated) mode, immune to host PYTHONPATH pollution |
| 🔁 **Self-Repairing Execution (ACR)** | bio_python failures return a `needs_repair` signal + stderr; the agent auto-repairs and retries (max 3 attempts), reporting honestly if it still fails |
| 📜 **Transparency Log** | Every code execution / tool call appends an async JSONL log (hash/preview/duration); `bio_log` traces back any analysis |
| 🧬 **Scientific Rigor Guardrails** | Persona enforces "biological conclusions must trace to tool output"; pure inference is marked [inferred — unverified] |
| 🧠 **Session Memory** | Successful code patterns + error→fix lessons accumulate automatically (local JSON); query via `bio_memory`, gets smarter over time |
| ⚙️ **Settings Panel** | "BioGenie" menu in dsh Settings sidebar (⚙️) — tabs: Overview (package info/config defaults), Skill Modules (47 entries grouped by main/domain/research/protocol/guide), Python Environment (venv packages), Tool Debug |
| 📚 **Protocol Knowledge Base** | 17 high-frequency task protocols (QC/alignment/BLAST/cloning/trees/structure/enrichment/publication figures/coordinate systems/statistics/differential expression/GSEA…), each with runnable code templates + pitfalls, bundled with the plugin |

---

## 📦 Installation

This plugin is published as the npm package `@dsh-bio/dsh-bio-genie`. Install it with the standard dsh `dsh plugin` command:

```sh
# Option 1: Install from npm (recommended, prebuilt code)
dsh plugin --profile web add @dsh-bio/dsh-bio-genie

# Option 2: Install from GitHub (fetches source; this plugin is pure ESM with no build step, loads directly)
dsh plugin --profile web add github:moonbowterfly/dsh-bio-genie

# Option 3: Install from a local directory (development)
dsh plugin --profile web add ./dsh-bio-genie
```

Restart the dsh web service to activate. On first startup the plugin bootstraps the Python environment in the background (download uv → Python 3.12 → venv → biopython, ~1-2 min); subsequent starts are ready in seconds.

Verify the plugin layer is active (no boot needed):

```sh
dsh --profile web --dump-config   # output should contain a "# == dsh-bio-genie" layer
```

### Troubleshooting: profile already contains local packages that break pnpm validation

If your profile already has locally installed packages **not on the npm registry** (e.g. skin plugins), `dsh plugin add` may fail with `ERR_PNPM_FETCH_404` during the full pnpm resolution. In that case, mount manually (verified to work):

```bash
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-bio/dsh-bio-genie
cd /path/to/dsh-bio-genie
cp -r src index.js cordis.patch.yml package.json skills prompts python docs \
  README.md README.en.md LICENSE THIRD_PARTY_NOTICES.md \
  ~/.dsh/profiles/web/node_modules/@dsh-bio/dsh-bio-genie/
```

Then in `~/.dsh/profiles/web/package.json`:
- Add to `dependencies`: `"@dsh-bio/dsh-bio-genie": "file:.../dsh-bio-genie"`
- Add to `dsh.profile.bundles`: `"@dsh-bio/dsh-bio-genie"`

Finally restart the dsh web service.

---

## 🛠 Tool Overview

### Executor (covers 100% of Biopython)

| Tool | Function |
|------|----------|
| `bio_python` | Run arbitrary Biopython Python programs (alignment/PDB/Phylo/motif/complex pipelines/custom analysis) |
| `bio_env` | Environment diagnostics / rebuild |
| `bio_log` | Execution log traceback (bio_python code hash/preview/duration + tool call records) |
| `bio_memory` | Session memory query (successful code patterns / error-fix lessons, gets smarter over time) |

### Semantic Tools (high-frequency stable operations)

| Tool | Function | Typical Triggers |
|------|----------|------------------|
| `bio_seq_analyze` | Length / GC% / reverse complement / **six-frame translation** (both strands) / molecular weight / protein AA composition | GC content, sequence features, translate |
| `bio_seq_translate` | DNA→protein translation (customizable genetic code table) | translate, protein sequence |
| `bio_seq_gc_skew` | GC skew (origin-of-replication detection) | skew, replication origin |
| `bio_seq_find_orf` | Longest open reading frame | ORF, coding region |
| `bio_seq_kmer` | k-mer frequency statistics | k-mer |
| `bio_seq_io_read` | Read FASTA/GenBank (UTF-8/GBK adaptive) | read fasta, parse file |
| `bio_seq_io_write` | Write sequence files | write fasta, save sequence |
| `bio_seq_restriction` | Restriction enzyme cut sites (CommOnly default / all optional) | restriction enzyme, cut site |
| `bio_blast_search` | Remote BLAST (NCBI qblast: blastn/blastp/blastx → hit accession/e-value/score/identity) | BLAST, homology search |
| `bio_msa` | Multiple sequence alignment (clustalw/muscle; returns Clustal+FASTA alignment, consensus, conservation stats; friendly hint if binary missing) | MSA, multiple alignment |
| `bio_phylo_build` | Phylogenetic tree construction (nj/upgma → Newick; accepts bio_msa alignment_fasta output) | phylogenetic tree, NJ |
| `bio_entrez_search` | NCBI search (esearch+esummary; db=gene returns gene metadata: full name/chromosome/aliases) | NCBI, search gene, gene info |
| `bio_entrez_fetch` | NCBI sequence retrieval | download sequence |
| `bio_enrichr` | Pathway/GO enrichment (gene symbol list → p-value ranked terms; GO/KEGG/Reactome/MSigDB libraries) | enrichment, pathway, GO, KEGG |
| `bio_pubmed_search` | PubMed literature search (PMID/title/journal/authors/DOI) | literature, PubMed |
| `bio_pubmed_abstract` | Structured abstracts by PMID (title/full abstract/authors/date/DOI) | read abstract, PMID |
| `bio_ref_genome` | Reference genome assembly info (Ensembl: assembly name/chromosomes/download dirs) | reference genome, assembly |

### Automatic Sequence-Type Detection

`bio_seq_analyze` defaults `seq_type` to `auto`, auto-detecting three types:
- Contains U but no T → **RNA**
- Contains IUPAC ambiguity codes (R/Y/S/W/K/M/B/D/H/V), X (unknown/modified base), or alignment gap chars (-/.) → **DNA** (primer/probe/SNP/alignment safe)
- Contains non-nucleic letters → **Protein**

X and gaps are treated as unknown bases during translation (Biopython standard behavior); sequences containing X/gaps never crash on ambiguous codons.

---

## 📚 Skill System (47 total)

### Master skill: `dsh-bio-genie`
Tool-layering decision tree: **check the semantic tool table first → use it if matched; otherwise write Biopython code with the bio_python executor**.

### 17 Domain Recipes + 4 Research Methods

| Skill | Biopython modules covered |
|-------|---------------------------|
| `bio-core` | Core workflow (load first for any analysis) |
| `bio-io` | Bio.SeqIO (FASTA/FASTQ/GenBank/EMBL…) |
| `bio-seq` | Bio.Seq / Bio.SeqUtils (GC, Tm, molecular weight) |
| `bio-align` | Bio.Align.PairwiseAligner / Bio.AlignIO |
| `bio-blast` | Bio.Blast (NCBIWWW / NCBIXML) |
| `bio-searchio` | Bio.SearchIO (BLAST/HMMER/Exonerate parsing) |
| `bio-entrez` | Bio.Entrez (esearch/efetch/esummary/elink) |
| `bio-phylo` | Bio.Phylo (Newick/Nexus, phylogenetics) |
| `bio-structure` | Bio.PDB (structure parsing, distances, superposition) |
| `bio-motif` | Bio.motifs (PWM, JASPAR/MEME) |
| `bio-restriction` | Bio.Restriction (cut sites, fragments) |
| `bio-utils` | Bio.Data.CodonTable (genetic codes, codon usage) |
| `bio-graphics` | Bio.Graphics.GenomeDiagram (map drawing) |
| `bio-popgen` | Bio.PopGen (population genetics) |
| `bio-figure` | Publication-grade figure consultant (figurelib: chart selection, 18 pitfalls, journal specs, CJK Chinese support) |
| `bio-ml` | scikit-learn ML on biological data (classification / dimred / clustering / feature importance) |
| `bio-dna-design` | DNA design (primers, codon optimization, plasmid maps) |

Research-method skills: `bio-survival-analysis`, `bio-variant-analysis`, `bio-literature-review`, `bio-paper-writing`. Plus 17 protocol templates and 8 agent guides bundled with the plugin.

---

## 🧞 Genie Expert Persona (`bio-genie` preset)

This plugin also ships a **dsh agent preset** — `bio-genie` — that turns the AI into a **biological-data genie** expert from the moment a session starts.

### What it is

- **Persona files** (`preset/bio-genie/preset.yml` + `agent.cordis.yml`) — override the base persona, telling AI: "you have 43 tools + 47 skills at hand".
- **Onboarding mantra** (`skills/dsh-bio-genie-expert.md`) — a meta-skill: "1. Inspect workspace → 2. Pick semantic tool / `bio_python` → 3. Fail by ACR three-layer repair → 4. Report with traceable chain".
- **One-shot install**: `pnpm install` runs postinstall hook to copy the preset to `~/.dsh/.agent-presets/bio-genie/`; no manual steps.

### What it is **not**

- ❌ **Does NOT own the 43 tools** — every `bio_*` tool is still injected by the plugin's `cordis.patch.yml`; the preset **does not redeclare** any tool to avoid conflicts.
- ❌ **Does NOT change the default persona** — after postinstall, "生物基因精灵" appears in dsh's preset selector; users **actively pick** it to activate. `agent-presets.default` is **not** changed to `bio-genie`.
- ❌ **Does NOT break other plugins** — presets and plugins are two independent seams in dsh; they coexist without conflict.

### How to use

1. **Install this plugin**: `pnpm add @dsh-bio/dsh-bio-genie` (postinstall handles the preset copy).
2. **Restart dsh web**.
3. **Settings panel** → select "**生物基因精灵**" persona.
4. The AI now opens each session with: "I'm the biological-data genie… your working directory is `{{cwd}}`… let me see what data you have first".

### Manual install / uninstall

```bash
# Manual copy (when postinstall fails)
node scripts/install-preset.js

# Force overwrite (overrides user-edited preset files)
node scripts/install-preset.js --force

# Dry run (only show what would happen)
node scripts/install-preset.js --dry-run

# Uninstall: delete the directory
#   Windows: rd /s /q %USERPROFILE%\.dsh\.agent-presets\bio-genie
#   macOS/Linux: rm -rf ~/.dsh/.agent-presets/bio-genie
```

### Troubleshooting

- **Preset selector doesn't show "生物基因精灵"** → check `~/.dsh/.agent-presets/bio-genie/preset.yml` exists; otherwise run `node scripts/install-preset.js` manually.
- **After switching to preset, tools are missing** → tools are injected by the plugin, not the preset; double-check the plugin is in `dependencies` (`pnpm ls @dsh-bio/dsh-bio-genie`).
- **Customize persona** → edit `~/.dsh/.agent-presets/bio-genie/agent.cordis.yml` directly (not auto-overwritten unless `--force`).

---

## 🚀 Usage Examples

**Scenario 1: Semantic tool path (high-frequency operations)**

> User: *"Analyze the GC content and EcoRI sites of the sequences in this file: D:/data/genes.fasta"*

```
Agent automatically:
1. bio_seq_io_read        → read FASTA
2. bio_seq_analyze        → GC content per sequence
3. bio_seq_restriction    → check EcoRI
4. Summary report + biological interpretation
```

**Scenario 2: Executor path (features not covered by semantic tools)**

> User: *"Draw a protein structure alignment of these two genes"*

```
Agent automatically:
1. Load bio-align / bio-structure skills
2. bio_python writes and runs a Biopython program
3. Produce files + report
```

**Scenario 3: Combined path (verified in practice)**

> User: *"Read the FASTA and analyze each sequence's GC, longest ORF and EcoRI sites"*

```
Agent automatically (measured behavior):
1. Load dsh-bio-genie master skill (decision guidance)
2. bio_seq_io_read reads the file
3. bio_python completes GC + ORF + restriction analysis in one pass
4. Output summary table (GC 48.28%, ORF 7 aa, EcoRI nt 3-8) + biological interpretation
```

---

## 🔧 Environment Bootstrap (Zero-Dependency Self-Provisioning)

On first tool call (or background warm-up at dsh startup) the plugin automatically:

```
1. Download uv            → $DSH_HOME/dsh-bio-genie/bin/uv
   (official GitHub; auto-fallback to Tsinghua PyPI uv wheel on failure, ~18MB/2s)
2. uv python install      → $DSH_HOME/dsh-bio-genie/python/ (private CPython 3.12)
   (auto-fallback to npmmirror python-build-standalone on failure)
3. uv venv --seed         → $DSH_HOME/dsh-bio-genie/python-env/ (pip preinstalled for on-demand packages)
4. uv pip install         → biopython + numpy + matplotlib + reportlab (auto-fallback to Tsinghua PyPI on failure)
```

- **Auto network adaptation**: each step tries official sources first, then automatically
  switches to domestic mirrors — zero configuration required. Power users can override
  mirrors via `DSH_BIO_UV_BASE` / `DSH_BIO_PYTHON_MIRROR` / `DSH_BIO_PYPI_INDEX`
  (uv's official `UV_PYTHON_INSTALL_MIRROR` / `UV_DEFAULT_INDEX` / `UV_INDEX_URL` are respected too)
- **Everything** lives under `$DSH_HOME/dsh-bio-genie/` (default `~/.dsh/dsh-bio-genie/`); delete it to fully uninstall
- **Assumes no system Python/uv** (self-provisioning); falls back to system python (if present) on bootstrap failure
- **Plugin upgrades don't lose the environment**: it lives in the DSH_HOME private directory, separate from the plugin itself (node_modules)
- **Idempotent**: ready environments reuse in seconds; failed bootstraps auto-retry
- First bootstrap needs network; semantic tools work offline afterwards

---

## 🔄 Compatibility

| Dimension | Requirement |
|-----------|-------------|
| **Node** | `^22.19 \|\| >=24` (same as dsh) |
| **dsh** | Peer deps `@deepseek-ai/dsh-tools` etc. at `^0.1.0-rc.6`, matching the current dsh source-tree build. If your host dsh is the older npm `latest` (`0.0.1-rc.1`), two copies of `dsh-tools` may resolve and cause type mismatches — use a dsh built from the source repository |
| **Platform** | Windows / macOS / Linux (x86_64 / arm64); platform-appropriate uv/Python is downloaded automatically |

---

## 🧩 Development

Pure ESM JavaScript, **no build step**, edit-and-run:

```bash
git clone https://github.com/dsh-bio/dsh-bio-genie
# Invoke the bootstrapper directly (first run downloads the environment, ~1-2 min):
node --input-type=module -e "import('./src/runtime.js').then(m => m.ensureEnvironment({}))"
```

- Architecture: see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Agent manuals**: [docs/agent-guide/](docs/agent-guide/) — 8 guides (overview / tool reference / skill navigation / bio_python programming / workflows / plotting / troubleshooting / rigor), registered as `dsh-bio-genie-guide-*` skills for the dsh agent
- Add a semantic tool: add an op in `python/bio_ops.py` + a `bioTool` entry in `src/tools.js`
- Add a domain skill: `skills/bio-xxx.md` + a SKILL_MANIFEST entry in `src/skills.js`
- **Skill language convention**: every skill (domain/protocol/guide) must declare a `language:` field in its leading frontmatter (`python` / `r` / `mixed` / `none`); enforced by test-skills.mjs

---

## 📄 License

- **dsh-bio-genie itself**: MIT License
- **Biopython**: Biopython License Agreement / BSD 3-Clause (permissive, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md))
- **numpy**: BSD License
- **scipilot-figure-skill** (figurelib plotting scripts): MIT (Copyright Haojae, see THIRD_PARTY_NOTICES.md)
- **K-Dense scientific-agent-skills** (figurelib style assets + knowledge protocol sources): MIT (Copyright K-Dense Inc., see THIRD_PARTY_NOTICES.md)
- **BioSQL intentionally excluded** (LGPL)

---

## 🙏 Acknowledgements

All of this project's biological computing power stands on **Biopython** — our thanks to the [biopython/biopython](https://github.com/biopython/biopython) project and all its contributors for 25 years of outstanding work. The high-quality implementations they maintain — sequence analysis, alignment, structural biology, phylogenetics and more — make "wish-style bioinformatics" possible. Biopython is released under the permissive [Biopython License Agreement](https://github.com/biopython/biopython/blob/master/LICENSE.rst) (BSD 3-Clause compatible), which allows free copying, modification and redistribution, so this plugin can rely on and promote it with confidence.

We also thank [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for its plugin-based agent framework, and the numpy community for its foundational contributions.

The publication-grade plotting stack (figurelib) is inspired by [Haojae/scipilot-figure-skill](https://github.com/Haojae/scipilot-figure-skill) (MIT) — its "visualization consultant" workflow and visual QA design — while style assets and some knowledge protocols reference [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) (MIT). Our thanks to both.
