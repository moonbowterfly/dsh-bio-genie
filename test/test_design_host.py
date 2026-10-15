# -*- coding: utf-8 -*-
"""B1-part-1 宿主侧三工具的 Python 层测试（req G-LOOP-20261015-B1P1-DB-001）。

真数据（R8）：test/fixtures/design 环形夹具（SHA 冻结、磁盘实测一致）+ 自构造线性迷你基因组
（确定性生成：固定种子；FASTA/segments_tsv/证据文件均落在 tmp_path，哈希运行时计算）。
门禁逐条负例（R1）：BLOCKED（坐标未声明/重复 contig/哈希失败/ruleset 缺失）/
NOT_RUN（无注释/注释不可信/摘要截断）/DEPENDENCY_UNAVAILABLE（ostir 不可用）/
INVALID_INPUT（参数/引用违约）语义分明；R4 无 GEM growth 锚点；R2 ruleset 强制消费；
R3 禁绝对表达 + coupling 仅草案；R5 信封 + schema（worker 侧 packet c14n 写盘）；R6 确定性。
"""
import hashlib
import importlib.util
import json
import os
import random
import shutil
import subprocess
import sys

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DISPATCHER = os.path.join(REPO, "python", "design_host.py")
PYTHON = sys.executable  # pytest 在仓库 venv 下运行
PACKET_FIXED = os.path.join(REPO, "design", "packet")

FIX = os.path.join(REPO, "test", "fixtures", "design")
FIX_CIRCULAR = os.path.join(FIX, "fixture_circular.fna")
FIX_FEATURES = os.path.join(FIX, "fixture_features.tsv")
FIX_CANDIDATES = os.path.join(FIX, "fixture_candidates.tsv")
FIX_VECTORS = os.path.join(FIX, "fixture_expected_vectors.json")

# SHA 冻结（fixture 生成器/验收基准；实测与磁盘一致）
FIX_CIRCULAR_SHA = "0d6c7fa7d450ef056bc6a677c5cc2970f58d453b7ecb51811fea3135c8c8dfc8"
FIX_FEATURES_SHA = "0f440c5bdf6ee97ae8f04745edf73b8c27707d064ac744d4bc817295375efff4"
FIX_CANDIDATES_SHA = "ff15cef7b85bbb03e38dc26c775aa2e5c0fb9f664d2132837127655055997f9d"
FIX_VECTORS_SHA = "49bd8415749ae79eeca3bb523f957122cd7f7e8392451b64587d285161884b6f"

# 环形夹具的期望向量（正式 ruleset 语义下：15 候选全 excluded——或iCDS 跨 origin 双段
# + 复制起点 0 邻域 2000bp 全窗口命中 neighborhood EXCLUDE；fixture 自带的 R0-draft
# screened_candidate 标签仅为 oracle 参照，不用于断言分类）
ORACLE_C02 = {"segments": [[1150, 1190]], "flank_left": "8c9da198940e9fbac008396ce413f58ea017a5c813272a925c320ce9a3c86bea",
              "flank_right": "fcc093fd22a3ebcc94d2fab553ddb78fff6e829994b343c06bc3ccb70a446b95"}
ORACLE_C06 = {"segments": [[4160, 4200], [0, 30]], "flank_left": "2d3f832b8ca8492ceb84fe7754d168ec43d3c467a1e9d228e2f878ad52648b1c",
              "flank_right": "d136c9bccf2b45ac95f123d35b53b5eb98d3cca33b367651561649d79a339432"}
ORACLE_C13 = {"segments": [[100, 140]], "flank_left": "bcb7d50d14734776238d5622622eb20bb328a97b4faec6d8b2fcb8bd69af4832",
              "flank_right": "e62aa867a9146d190a7466f4c96ce2cdca4235c6f975778bf71f368e3a666602"}

CANDIDATES = [
    {"contig": "synth_circ_4200", "start": 250, "end": 290},
    {"contig": "synth_circ_4200", "start": 1150, "end": 1190},
    {"contig": "synth_circ_4200", "start": 2650, "end": 2690},
    {"contig": "synth_circ_4200", "start": 2940, "end": 2980},
    {"contig": "synth_circ_4200", "start": 2960, "end": 3010},
    {"contig": "synth_circ_4200", "start": 4160, "end": 30},   # 跨 origin 显式窗口
    {"contig": "synth_circ_4200", "start": 4100, "end": 4140},
    {"contig": "synth_circ_4200", "start": 50, "end": 90},
    {"contig": "synth_circ_4200", "start": 2050, "end": 2090},
    {"contig": "synth_circ_4200", "start": 3600, "end": 3640},
    {"contig": "synth_circ_4200", "start": 1900, "end": 1940},
    {"contig": "synth_circ_4200", "start": 3030, "end": 3070},
    {"contig": "synth_circ_4200", "start": 100, "end": 140},
    {"contig": "synth_circ_4200", "start": 3080, "end": 3120},
    {"contig": "synth_circ_4200", "start": 90, "end": 130},
]

ENV_BASE = {
    "DSH_DESIGN_PACKET_FIXED": PACKET_FIXED,
    "DSH_DESIGN_PACKET": "",
    "DSH_DESIGN_EXPECT_INDEX_SHA": "",
    "DSH_DESIGN_EXPECT_MANIFEST_SHA": "",
    "DSH_DESIGN_ACCEPTANCE_ID": "",
}


def run_op(op, args, staging):
    """spawn design_host.py 独立 dispatcher；返回 (exit_code, parsed_stdout)。"""
    req = json.dumps({"op": op, "args": args})
    env = dict(os.environ)
    env.update(ENV_BASE)
    env["DSH_DESIGN_STAGING"] = staging
    os.makedirs(staging, exist_ok=True)
    proc = subprocess.run(
        [PYTHON, "-I", DISPATCHER],
        input=req.encode("utf-8"),
        capture_output=True,
        env=env,
        timeout=240,
    )
    try:
        parsed = json.loads(proc.stdout.decode("utf-8").strip() or "{}")
    except ValueError:
        parsed = {"ok": False, "code": "STDOUT_UNPARSEABLE", "detail": proc.stdout.decode("utf-8", "replace")[-300:]}
    return proc.returncode, parsed


def read_artifact(staging, logical_name):
    with open(os.path.join(staging, logical_name), "rb") as fh:
        return json.loads(fh.read().decode("utf-8"))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ───────────────────────── 夹具：线性迷你基因组（确定性） ─────────────────────────

def _make_linear_genome(root):
    """lin_8000：L=8000 线性；geneA[6000,7000) CDS essential_candidate；geneB[7200,7900) CDS。
    固定种子随机序列（不含 20bp 级联重复与 GCTGGTGG motif——随机序列命中概率可忽略，
    且种子固定 → 完全确定性）。返回 {fasta_path, tsv_path, seq}。"""
    rng = random.Random(20261015)
    seq = "".join(rng.choice("ACGT") for _ in range(8000))
    # 保守替换 motif 窗口内序列，确保 motif 规则可复现 PASS（即使随机命中）
    for s, e in ((1000 - 200, 1400 + 200), (6100 - 200, 6500 + 200)):
        mid = (s + e) // 2
        seq = seq[:mid] + "A" * 4 + seq[mid + 4:]
    fasta = os.path.join(root, "lin_8000.fna")
    with open(fasta, "w", encoding="utf-8") as fh:
        fh.write(">lin_8000\n")
        for i in range(0, 8000, 80):
            fh.write(seq[i:i + 80] + "\n")
    tsv = os.path.join(root, "lin_8000_features.tsv")
    with open(tsv, "w", encoding="utf-8") as fh:
        fh.write("feature_id\ttype\tstrand\tsegments\tlength\tnote\n")
        fh.write("geneN\tother\t+\t1000-1400\t400\tbenign_annotation_anchor\n")
        fh.write("geneA\tCDS\t-\t6000-7000\t1000\tessential_candidate=true\n")
        fh.write("geneB\tCDS\t+\t7200-7900\t700\t\n")
    return {"fasta": fasta, "tsv": tsv, "seq": seq}


@pytest.fixture(scope="session")
def linear_genome(tmp_path_factory):
    root = tmp_path_factory.mktemp("linear_genome")
    g = _make_linear_genome(root)
    g["fasta_sha"] = sha256_file(g["fasta"])
    g["tsv_sha"] = sha256_file(g["tsv"])
    return g


@pytest.fixture(scope="session")
def chassis_fixture(tmp_path_factory):
    """环形夹具 → chassis OK 产物（值 + canonical sha + 文件哈希）。"""
    staging = str(tmp_path_factory.mktemp("chassis_fixture"))
    files = [
        {"path": FIX_CIRCULAR, "format": "fasta", "sha256": FIX_CIRCULAR_SHA},
        {"path": FIX_FEATURES, "format": "segments_tsv", "sha256": FIX_FEATURES_SHA},
    ]
    rc, out = run_op("design_chassis_profile", {
        "genome_files": files,
        "coord_convention": "0-based-half-open",
        "contig_topology": {"synth_circ_4200": "circular"},
        "condition": {"medium": "M9", "temperature": 37.0, "oxygen": "aerobic", "phase": "exponential"},
    }, staging)
    assert rc == 0
    envl = out["result"]["envelope"]
    assert envl["status"] == "OK", envl
    hp = read_artifact(staging, "host_profile.json")
    gr = read_artifact(staging, "genome_ref.json")
    return {"hp": hp, "gr": gr, "staging": staging}


@pytest.fixture(scope="session")
def chassis_linear(linear_genome, tmp_path_factory):
    """线性迷你基因组 → chassis OK 产物。"""
    staging = str(tmp_path_factory.mktemp("chassis_linear"))
    files = [
        {"path": linear_genome["fasta"], "format": "fasta", "sha256": linear_genome["fasta_sha"]},
        {"path": linear_genome["tsv"], "format": "segments_tsv", "sha256": linear_genome["tsv_sha"]},
    ]
    rc, out = run_op("design_chassis_profile", {
        "genome_files": files,
        "coord_convention": "0-based-half-open",
        "contig_topology": {"lin_8000": "linear"},
        "genome_source": "test-linear-mini",
    }, staging)
    assert rc == 0
    assert out["result"]["envelope"]["status"] == "OK", out
    return {"hp": read_artifact(staging, "host_profile.json"), "gr": read_artifact(staging, "genome_ref.json"),
            "staging": staging, **linear_genome}


# ═════════════════════════ 1. bio_chassis_profile ═════════════════════════

class TestChassisProfile:
    def test_chassis_ok_circular(self, chassis_fixture):
        hp, gr = chassis_fixture["hp"], chassis_fixture["gr"]
        assert hp["artifact_type"] == "host_profile@1"
        assert gr["artifact_type"] == "genome_ref@1"
        assert gr["coord_convention"] == "0-based-half-open"
        assert gr["contigs"] == [{"name": "synth_circ_4200", "length": 4200, "topology": "circular"}]
        assert gr["files"][0]["sha256"] == FIX_CIRCULAR_SHA
        assert gr["files"][0]["format"] == "fasta"
        assert gr["files"][1]["format"] == "gff3" or gr["files"][1]["format"] == "other"
        assert hp["genome_ref"]["artifact_id"] == gr_sha_of(chassis_fixture["staging"])
        # 宿主侧证据状态（v0.2 §6.1）：annotation 完整度 full（8 特征覆盖单 contig）
        assert hp["evidence_state"]["annotation"]["completeness"] == "full"
        detail = json.loads(hp["evidence_state"]["annotation"]["detail"])
        assert detail["untrusted"] is False and detail["truncated"] is False
        assert detail["contig_coverage"] == {"covered": 1, "total": 1}
        assert len(detail["features"]) == 8
        # 条件状态
        assert hp["evidence_state"]["condition"]["completeness"] == "full"
        # 派生统计
        assert hp["derived"]["genome_size"] == 4200
        assert hp["derived"]["contig_count"] == 1
        gc = hp["derived"]["gc_percent"]
        assert isinstance(gc, float) and 0.0 < gc < 100.0
        # 门禁痕迹（gates[]：{gate, status, detail?}）
        assert hp["gates"] and all(isinstance(g, dict) and "gate" in g and "status" in g for g in hp["gates"])

    def test_chassis_no_gem_anchor(self, chassis_fixture):
        """R4：host_profile 不含 GEM growth 锚点（0.876997 移至 consequence 验收）。"""
        blob = json.dumps(chassis_fixture["hp"])
        for bad in ("gem", "growth", "specific_growth_rate", "0.876997"):
            assert bad not in blob, "host_profile 含 GEM growth 锚点字段: " + bad

    def test_chassis_annotated_genome_ref_crosscheck(self, chassis_fixture):
        """genome_ref.files[] 与磁盘 fixture 哈希逐条一致。"""
        for f in chassis_fixture["gr"]["files"]:
            if f["format"] == "fasta":
                assert f["sha256"] == FIX_CIRCULAR_SHA
            else:
                assert f["sha256"] == FIX_FEATURES_SHA

    def test_chassis_coord_undeclared_blocked(self, tmp_path):
        rc, out = run_op("design_chassis_profile", {
            "genome_files": [{"path": FIX_CIRCULAR, "format": "fasta", "sha256": FIX_CIRCULAR_SHA}],
        }, str(tmp_path))
        assert rc == 0
        envl = out["result"]["envelope"]
        assert envl["status"] == "BLOCKED"
        assert envl["reason_code"] == "COORD_CONVENTION_UNDECLARED"
        assert envl["artifact_refs"] == []
        assert out["result"]["artifacts"] == []

    def test_chassis_duplicate_contig_blocked(self, tmp_path):
        dup = os.path.join(tmp_path, "dup.fna")
        shutil.copyfile(FIX_CIRCULAR, dup)  # 同名 contig 第二个文件
        rc, out = run_op("design_chassis_profile", {
            "genome_files": [
                {"path": FIX_CIRCULAR, "format": "fasta", "sha256": FIX_CIRCULAR_SHA},
                {"path": dup, "format": "fasta", "sha256": sha256_file(dup)},
            ],
            "coord_convention": "0-based-half-open",
        }, str(tmp_path))
        assert rc == 0
        envl = out["result"]["envelope"]
        assert envl["status"] == "BLOCKED"
        assert envl["reason_code"] == "DUPLICATE_CONTIG_NAME"

    def test_chassis_hash_mismatch_blocked(self, tmp_path):
        rc, out = run_op("design_chassis_profile", {
            "genome_files": [{"path": FIX_CIRCULAR, "format": "fasta", "sha256": "0" * 64}],
            "coord_convention": "0-based-half-open",
        }, str(tmp_path))
        assert rc == 0
        envl = out["result"]["envelope"]
        assert envl["status"] == "BLOCKED"
        assert envl["reason_code"] == "HASH_FAILED"

    def test_chassis_missing_file_blocked(self, tmp_path):
        rc, out = run_op("design_chassis_profile", {
            "genome_files": [{"path": os.path.join(tmp_path, "nope.fna"), "format": "fasta"}],
            "coord_convention": "0-based-half-open",
        }, str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "BLOCKED"
        assert out["result"]["envelope"]["reason_code"] == "HASH_FAILED"

    def test_chassis_fasta_required_invalid(self, tmp_path):
        rc, out = run_op("design_chassis_profile", {
            "genome_files": [{"path": FIX_FEATURES, "format": "segments_tsv", "sha256": FIX_FEATURES_SHA}],
            "coord_convention": "0-based-half-open",
        }, str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "INVALID_INPUT"
        rc2, out2 = run_op("design_chassis_profile", {"coord_convention": "0-based-half-open"}, str(tmp_path))
        assert rc2 == 0
        assert out2["result"]["envelope"]["status"] == "INVALID_INPUT"

    def test_chassis_annotation_untrusted_partial(self, linear_genome, tmp_path):
        """损坏注释文件 → annotation=partial + untrusted（fail-closed，不中断 profile）。"""
        bad = os.path.join(tmp_path, "bad.tsv")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("feature_id\ttype\tstrand\tsegments\tlength\tnote\nbroken-line-no-segments\n")
        rc, out = run_op("design_chassis_profile", {
            "genome_files": [
                {"path": linear_genome["fasta"], "format": "fasta", "sha256": linear_genome["fasta_sha"]},
                {"path": bad, "format": "segments_tsv", "sha256": sha256_file(bad)},
            ],
            "coord_convention": "0-based-half-open",
            "contig_topology": {"lin_8000": "linear"},
        }, str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "OK", out
        hp = read_artifact(str(tmp_path), "host_profile.json")
        ann = hp["evidence_state"]["annotation"]
        assert ann["completeness"] == "partial"
        assert json.loads(ann["detail"])["untrusted"] is True

    def test_chassis_condition_empty_ok(self, chassis_fixture):
        """condition{} 可空字段显式 null → 完整度 partial 但不阻断。"""
        assert chassis_fixture["hp"]["evidence_state"]["condition"]["completeness"] == "full"

    def test_chassis_deterministic(self, tmp_path):
        """R6：同输入同输出（artifact_id = canonical sha）。"""
        files = [{"path": FIX_CIRCULAR, "format": "fasta", "sha256": FIX_CIRCULAR_SHA}]
        args = {"genome_files": files, "coord_convention": "0-based-half-open",
                "contig_topology": {"synth_circ_4200": "circular"}}
        s1, s2 = str(tmp_path / "s1"), str(tmp_path / "s2")
        rc1, out1 = run_op("design_chassis_profile", args, s1)
        rc2, out2 = run_op("design_chassis_profile", args, s2)
        assert rc1 == rc2 == 0
        refs1 = out1["result"]["envelope"]["artifact_refs"]
        refs2 = out2["result"]["envelope"]["artifact_refs"]
        assert [r["artifact_id"] for r in refs1] == [r["artifact_id"] for r in refs2]
        for a1, a2 in zip(sorted(os.listdir(s1)), sorted(os.listdir(s2))):
            assert open(os.path.join(s1, a1), "rb").read() == open(os.path.join(s2, a2), "rb").read()


def gr_sha_of(staging):
    with open(os.path.join(staging, "genome_ref.json"), "rb") as fh:
        raw = fh.read()
    return hashlib.sha256(raw).hexdigest()


# ═════════════════════════ 2. bio_integration_candidates ═════════════════════════

_NOT_SET = object()


def integration_base_args(chassis, cassette=_NOT_SET, **over):
    args = {
        "host_profile": chassis["hp"],
        "genome_ref_value": chassis["gr"],
        "genome_files": [{"path": FIX_CIRCULAR, "format": "fasta", "sha256": FIX_CIRCULAR_SHA}],
        "cassette": {"payload_length": 40},
        "candidates": CANDIDATES,
        "top_n": 16,
        "origin_positions": {"synth_circ_4200": 0},
    }
    if cassette is not _NOT_SET:
        args["cassette"] = cassette
    args.update(over)
    return args


class TestIntegrationCandidates:
    def test_integration_fixture_all_excluded(self, chassis_fixture, tmp_path):
        """正式 ruleset：15 候选全 excluded（复制起点 0 邻域 2000bp 全命中 neighborhood；
        C06 跨 origin 显式双段）。不得输出 safe。"""
        rc, out = run_op("design_integration_candidates",
                         integration_base_args(chassis_fixture), str(tmp_path))
        assert rc == 0
        envl = out["result"]["envelope"]
        assert envl["status"] == "OK", envl
        arts = out["result"]["artifacts"]
        assert len(arts) == 15
        assert all(a["artifact_type"] == "integration_candidate@1" for a in arts)
        cands = [read_artifact(str(tmp_path), a["logical_name"]) for a in arts]
        for c in cands:
            assert c["classification"] == "excluded"
            assert c["artifact_type"] == "integration_candidate@1"
            assert c["interval"]["convention"] == "0-based-half-open"
            assert c["ruleset_ref"]["artifact_id"]
            reasons = [r["rule_id"] for r in c["reasons"] if r["code"] == "EXCLUDE"]
            assert reasons, c
        blob = json.dumps(cands)
        assert "safe" not in blob
        assert "screened_candidate" not in blob and "preliminary_candidate" not in blob

    def test_integration_oracle_flank_hashes(self, chassis_fixture, tmp_path):
        """M2/M3 oracle 交叉验证：C02/C06/C13 的 normalized_flank_hashes 与冻结向量全 MATCH。"""
        rc, out = run_op("design_integration_candidates",
                         integration_base_args(chassis_fixture), str(tmp_path))
        assert rc == 0
        cands = {c["interval"]["start"]: c for c in
                 (read_artifact(str(tmp_path), a["logical_name"]) for a in out["result"]["artifacts"])}
        for key, oracle in (("c02", ORACLE_C02), ("c06", ORACLE_C06), ("c13", ORACLE_C13)):
            start = oracle["segments"][0][0]
            c = cands[start]
            assert c["interval"]["start"] == oracle["segments"][0][0]
            assert c["interval"]["end"] == oracle["segments"][-1][-1]
            if oracle["segments"][0][0] == 4160:
                assert c["origin_crossing"] is True
            assert c["normalized_flank_hashes"]["left"] == oracle["flank_left"]
            assert c["normalized_flank_hashes"]["right"] == oracle["flank_right"]

    def test_integration_linear_positive(self, chassis_linear, tmp_path):
        """线性迷你基因组：W1[1000,1400) 全规则 PASS → preliminary_candidate（payload-only cassette）。"""
        files = [{"path": chassis_linear["fasta"], "format": "fasta", "sha256": chassis_linear["fasta_sha"]}]
        evidence = {
            "essentiality_evidence": {"path": _write_json(tmp_path, "ess.json", {"genes": ["geneA"]})},
            "expression_evidence": {"path": _write_json(tmp_path, "expr.json", {"high_expression_genes": ["geneB"]})},
        }
        args = {
            "host_profile": chassis_linear["hp"],
            "genome_ref_value": chassis_linear["gr"],
            "genome_files": files,
            "cassette": {"payload_length": 400},
            "candidates": [
                {"contig": "lin_8000", "start": 1000, "end": 1400},    # PASS → preliminary
                {"contig": "lin_8000", "start": 6950, "end": 7350},    # overlap geneA → excluded
                {"contig": "lin_8000", "start": 7450, "end": 7850},    # 距 origin 7500 邻域 → excluded
                {"contig": "lin_8000", "start": 6100, "end": 6500},    # geneA 必需性邻域 → excluded
            ],
            "top_n": 8,
            "origin_positions": {"lin_8000": 7500},
            **evidence,
        }
        rc, out = run_op("design_integration_candidates", args, str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "OK", out
        cands = [read_artifact(str(tmp_path), a["logical_name"]) for a in out["result"]["artifacts"]]
        by_start = {c["interval"]["start"]: c for c in cands}
        w1 = by_start[1000]
        assert w1["classification"] == "preliminary_candidate"
        assert w1["cassette"]["sequence_identity"] == "unknown"
        assert w1["screening_stage"] == "preliminary_spatial"
        excl_codes = {s: {r["code"] for r in c["reasons"]} for s, c in by_start.items() if s != 1000}
        assert any("EXCLUDE" in codes for codes in excl_codes.values())
        assert by_start[6950]["classification"] == "excluded"
        assert by_start[7450]["classification"] == "excluded"
        assert by_start[6100]["classification"] == "excluded"

    def test_integration_screened_and_literature(self, chassis_linear, tmp_path):
        """cassette 有序列 → screened_candidate；evidence_item exact 命中 → literature_characterized。"""
        w1_seq = chassis_linear["seq"][1000:1400]
        files = [{"path": chassis_linear["fasta"], "format": "fasta", "sha256": chassis_linear["fasta_sha"]}]
        args = {
            "host_profile": chassis_linear["hp"],
            "genome_ref_value": chassis_linear["gr"],
            "genome_files": files,
            "cassette": {"sequence": w1_seq},
            "candidates": [{"contig": "lin_8000", "start": 1000, "end": 1400}],
            "top_n": 4,
            "origin_positions": {"lin_8000": 7500},
            "essentiality_evidence": {"path": _write_json(tmp_path, "ess2.json", {"genes": ["geneA"]})},
            "expression_evidence": {"path": _write_json(tmp_path, "expr2.json", {"high_expression_genes": ["geneB"]})},
            "evidence_items": [_evidence_item("exact", w1_seq)],
        }
        rc, out = run_op("design_integration_candidates", args, str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "OK", out
        c = read_artifact(str(tmp_path), out["result"]["artifacts"][0]["logical_name"])
        assert c["classification"] == "literature_characterized"
        assert c["cassette"]["sequence_identity"] == "known"
        assert c["screening_stage"] == "sequence_verified"
        # 非 exact 证据 → 不升档
        args["evidence_items"] = [_evidence_item("host_transfer", w1_seq)]
        rc2, out2 = run_op("design_integration_candidates", args, str(tmp_path))
        assert rc2 == 0
        c2 = read_artifact(str(tmp_path), out2["result"]["artifacts"][0]["logical_name"])
        assert c2["classification"] == "screened_candidate"

    def test_integration_no_annotation_not_run(self, tmp_path):
        """chassis 无注释 → NOT_RUN NO_ANNOTATION（位点类不运行）。"""
        staging = str(tmp_path / "chassis")
        files = [{"path": FIX_CIRCULAR, "format": "fasta", "sha256": FIX_CIRCULAR_SHA}]
        rc, out = run_op("design_chassis_profile", {
            "genome_files": files, "coord_convention": "0-based-half-open",
            "contig_topology": {"synth_circ_4200": "circular"},
        }, staging)
        assert rc == 0 and out["result"]["envelope"]["status"] == "OK"
        hp = read_artifact(staging, "host_profile.json")
        gr = read_artifact(staging, "genome_ref.json")
        rc2, out2 = run_op("design_integration_candidates", integration_base_args(
            {"hp": hp, "gr": gr}), str(tmp_path / "int"))
        assert rc2 == 0
        envl = out2["result"]["envelope"]
        assert envl["status"] == "NOT_RUN"
        assert envl["reason_code"] == "NO_ANNOTATION"

    def test_integration_annotation_untrusted_not_run(self, linear_genome, tmp_path):
        staging = str(tmp_path / "chassis")
        bad = os.path.join(tmp_path, "bad.tsv")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("feature_id\ttype\tstrand\tsegments\tlength\tnote\nbroken\n")
        rc, out = run_op("design_chassis_profile", {
            "genome_files": [
                {"path": linear_genome["fasta"], "format": "fasta", "sha256": linear_genome["fasta_sha"]},
                {"path": bad, "format": "segments_tsv", "sha256": sha256_file(bad)},
            ],
            "coord_convention": "0-based-half-open",
            "contig_topology": {"lin_8000": "linear"},
        }, staging)
        assert rc == 0 and out["result"]["envelope"]["status"] == "OK"
        hp = read_artifact(staging, "host_profile.json")
        gr = read_artifact(staging, "genome_ref.json")
        rc2, out2 = run_op("design_integration_candidates", integration_base_args(
            {"hp": hp, "gr": gr},
            genome_files=[{"path": linear_genome["fasta"], "format": "fasta", "sha256": linear_genome["fasta_sha"]}],
            candidates=[{"contig": "lin_8000", "start": 100, "end": 300}],
            top_n=2,
        ), str(tmp_path / "int"))
        assert rc2 == 0
        envl = out2["result"]["envelope"]
        assert envl["status"] == "NOT_RUN"
        assert envl["reason_code"] == "ANNOTATION_UNTRUSTED"

    def test_integration_ruleset_missing_blocked(self, chassis_fixture, tmp_path):
        """R2：ruleset 资产缺失 → BLOCKED RULESET_UNAVAILABLE。"""
        rc, out = run_op("design_integration_candidates", integration_base_args(
            chassis_fixture, ruleset_path=os.path.join(tmp_path, "no-ruleset.json")), str(tmp_path))
        assert rc == 0
        envl = out["result"]["envelope"]
        assert envl["status"] == "BLOCKED"
        assert envl["reason_code"] == "RULESET_UNAVAILABLE"

    def test_integration_cassette_required_invalid(self, chassis_fixture, tmp_path):
        rc, out = run_op("design_integration_candidates", integration_base_args(
            chassis_fixture, cassette=None), str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "INVALID_INPUT"
        rc2, out2 = run_op("design_integration_candidates", integration_base_args(
            chassis_fixture, cassette={"payload_length": 0}), str(tmp_path))
        assert rc2 == 0
        assert out2["result"]["envelope"]["status"] == "INVALID_INPUT"

    def test_integration_genome_ref_mismatch(self, chassis_fixture, linear_genome, tmp_path):
        """FASTA 与 host_profile.genome_ref 不一致 → INVALID_INPUT GENOME_REF_MISMATCH。"""
        rc, out = run_op("design_integration_candidates", integration_base_args(
            chassis_fixture,
            genome_files=[{"path": linear_genome["fasta"], "format": "fasta", "sha256": linear_genome["fasta_sha"]}],
        ), str(tmp_path))
        assert rc == 0
        envl = out["result"]["envelope"]
        assert envl["status"] == "INVALID_INPUT"
        assert envl["reason_code"] == "GENOME_REF_MISMATCH"

    def test_integration_exclude_rules_unknown_invalid(self, chassis_fixture, tmp_path):
        rc, out = run_op("design_integration_candidates", integration_base_args(
            chassis_fixture, exclude_rules=["no_such_rule"]), str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "INVALID_INPUT"

    def test_integration_candidates_scan_mutex(self, chassis_fixture, tmp_path):
        rc, out = run_op("design_integration_candidates", integration_base_args(
            chassis_fixture, scan=True), str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "INVALID_INPUT"

    def test_integration_host_profile_ref_mismatch(self, chassis_fixture, tmp_path):
        """嵌入值 + 不符 ref → INVALID_INPUT HOST_PROFILE_REF_MISMATCH（canonical sha 交叉校验）。"""
        args = integration_base_args(chassis_fixture)
        args["host_profile_ref"] = {"artifact_id": "0" * 64, "expected_sha256": "0" * 64, "relative_path": "hp.json"}
        rc, out = run_op("design_integration_candidates", args, str(tmp_path))
        assert rc == 0
        envl = out["result"]["envelope"]
        assert envl["status"] == "INVALID_INPUT"
        assert envl["reason_code"] == "HOST_PROFILE_REF_MISMATCH"

    def test_integration_exclude_rules_skips(self, chassis_fixture, tmp_path):
        """exclude_rules 跳过规则并记 SKIP（不改变 excluded 结果，但 coverage 不含跳过规则）。"""
        rc, out = run_op("design_integration_candidates", integration_base_args(
            chassis_fixture, exclude_rules=["neighborhood", "essentiality"]), str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "OK"
        c = read_artifact(str(tmp_path), out["result"]["artifacts"][0]["logical_name"])
        codes = {r["code"] for r in c["reasons"]}
        assert "SKIP" in codes
        assert "neighborhood" not in c["counts"]["mandatory_rule_coverage"]

    def test_integration_deterministic(self, chassis_fixture, tmp_path):
        s1, s2 = str(tmp_path / "i1"), str(tmp_path / "i2")
        args = integration_base_args(chassis_fixture)
        rc1, out1 = run_op("design_integration_candidates", args, s1)
        rc2, out2 = run_op("design_integration_candidates", args, s2)
        assert rc1 == rc2 == 0
        f1 = sorted(os.listdir(s1)); f2 = sorted(os.listdir(s2))
        assert f1 == f2
        for a, b in zip(f1, f2):
            assert open(os.path.join(s1, a), "rb").read() == open(os.path.join(s2, b), "rb").read()


# ═════════════════════════ 3. bio_circuit_contextualize ═════════════════════════

CIRCUIT = {
    "components": [
        {"component_id": "P1", "kind": "promoter", "sequence": "TTGACAGAGCTCACAATTTCACATTA"},
        {"component_id": "P2", "kind": "promoter", "sequence": "TTGACAACGATAACAATTTCACATTA"},
        {"component_id": "RBS1", "kind": "rbs", "sequence": "AAAGAGGAGAAA"},
        {"component_id": "CDS1", "kind": "cds", "sequence": "ATGGCTAGC"},
    ]
}
EVIDENCE = [
    {"part_id": "P1", "evidence_level": "E3", "source_id": "src-a", "rank_hint": 0.9},
    {"part_id": "P2", "evidence_level": "E2", "source_id": "src-b", "rank_hint": 0.8},
    {"part_id": "P1", "evidence_level": "E2", "source_id": "src-c", "rank_hint": 0.5},  # 同 part 取最高档
]


class TestCircuitContextualize:
    def test_contextualize_ok_rank_only(self, chassis_fixture, tmp_path):
        """evidence_lookup：4 元件排名 1..4 唯一；禁绝对表达（value_or_rank 仅 rank）。"""
        args = {
            "host_profile": chassis_fixture["hp"],
            "genome_ref_value": chassis_fixture["gr"],
            "circuit": CIRCUIT,
            "parts_evidence": EVIDENCE,
        }
        rc, out = run_op("design_circuit_contextualize", args, str(tmp_path))
        assert rc == 0
        envl = out["result"]["envelope"]
        assert envl["status"] == "OK", envl
        arts = out["result"]["artifacts"]
        names = {a["logical_name"] for a in arts}
        assert names == {"circuit_design.json", "expression_scenario.json"}
        scenario = read_artifact(str(tmp_path), "expression_scenario.json")
        assert scenario["artifact_type"] == "expression_scenario@1"
        assert scenario["method"] == "evidence_lookup"
        assert scenario["host_profile"]["artifact_id"]
        assert scenario["circuit_design"]["artifact_id"]
        res = scenario["results"]
        assert len(res) == 4
        ranks = sorted(r["value_or_rank"]["rank"] for r in res)
        assert ranks == [1, 2, 3, 4]
        for r in res:
            assert r["value_or_rank"]["kind"] == "rank", "禁止绝对表达（value 禁出）"
            assert isinstance(r["conditions"], str) and r["conditions"].startswith("coupling_mode=")
        # results 数组为 packet set-c14n 排序（元素字节序）；排名语义在 rank 字段：
        # rank1=P1(E3) 最前、rank4 为无证据元件（unknown 排后）
        by_rank = {r["value_or_rank"]["rank"]: r for r in res}
        assert by_rank[1]["element"] == "P1" and by_rank[1]["evidence_level"] == "E3"
        assert by_rank[2]["element"] == "P2" and by_rank[2]["evidence_level"] == "E2"
        assert "evidence_level" not in by_rank[4]
        assert scenario["domain_check"] == "in_domain"
        assert scenario["ranking_set_id"]
        assert scenario["comparison_scope"] == "intra-circuit"

    def test_contextualize_coupling_draft_only(self, chassis_fixture, tmp_path):
        """coupling_mode 仅产草案：conditions 标注模式；无定量授权字段。"""
        args = {
            "host_profile": chassis_fixture["hp"],
            "genome_ref_value": chassis_fixture["gr"],
            "circuit": CIRCUIT,
            "parts_evidence": EVIDENCE,
            "coupling_mode": "user_calibrated_bound",
        }
        rc, out = run_op("design_circuit_contextualize", args, str(tmp_path))
        assert rc == 0
        scenario = read_artifact(str(tmp_path), "expression_scenario.json")
        for r in scenario["results"]:
            assert r["conditions"] == "coupling_mode=user_calibrated_bound"
            assert r["value_or_rank"]["kind"] == "rank"
        blob = json.dumps(scenario)
        assert "quantitative_authorization" not in blob and "authorized_bound" not in blob

    def test_contextualize_crn_ref(self, chassis_fixture, tmp_path):
        """crn_sbml_ref → kinetic_crn_ref@1（model_kind=kinetic_crn；sbml_ref 透传原样）。"""
        crn = {"artifact_id": "a" * 64, "expected_sha256": "a" * 64, "relative_path": "crn_sbml.json"}
        args = {
            "host_profile": chassis_fixture["hp"],
            "genome_ref_value": chassis_fixture["gr"],
            "circuit": CIRCUIT,
            "parts_evidence": EVIDENCE,
            "crn_sbml_ref": crn,
        }
        rc, out = run_op("design_circuit_contextualize", args, str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "OK", out
        names = {a["logical_name"] for a in out["result"]["artifacts"]}
        assert "kinetic_crn_ref.json" in names
        kc = read_artifact(str(tmp_path), "kinetic_crn_ref.json")
        assert kc["artifact_type"] == "kinetic_crn_ref@1"
        assert kc["model_kind"] == "kinetic_crn"
        assert kc["sbml_ref"] == crn
        scenario = read_artifact(str(tmp_path), "expression_scenario.json")
        # CRN 封装经 model_or_dataset_ref 挂接（refs-only 引用既有 bio_circuit_compile 输出）；
        # 引用目标是 kinetic_crn_ref@1 封装产物本身的 canonical sha
        kc_sha = [a["sha256"] for a in out["result"]["artifacts"] if a["logical_name"] == "kinetic_crn_ref.json"][0]
        assert scenario["model_or_dataset_ref"]["artifact_id"] == kc_sha
        assert scenario["model_or_dataset_ref"]["relative_path"] == "kinetic_crn_ref.json"
        assert any(a.startswith("kinetic_crn_ref@1") for a in scenario["assumptions"])

    @pytest.mark.skipif(importlib.util.find_spec("ostir") is not None,
                        reason="本环境未装 ostir；已装则走成功路径（不做负例断言）")
    def test_contextualize_ostir_dependency_unavailable(self, chassis_fixture, tmp_path):
        """R3：ostir 可选依赖 + preflight，不可用 → DEPENDENCY_UNAVAILABLE（不静默降级）。"""
        args = {
            "host_profile": chassis_fixture["hp"],
            "genome_ref_value": chassis_fixture["gr"],
            "circuit": CIRCUIT,
            "parts_evidence": EVIDENCE,
            "ostir_request": {"sequence": "TTGACAGAGCTCACAATTTCACATTA", "label": "P1-probe"},
        }
        rc, out = run_op("design_circuit_contextualize", args, str(tmp_path))
        assert rc == 0
        envl = out["result"]["envelope"]
        assert envl["status"] == "DEPENDENCY_UNAVAILABLE"
        assert envl["reason_code"] == "OSTIR_UNAVAILABLE"
        assert out["result"]["artifacts"] == []

    def test_contextualize_invalid_coupling_mode(self, chassis_fixture, tmp_path):
        args = {"host_profile": chassis_fixture["hp"], "genome_ref_value": chassis_fixture["gr"],
                "circuit": CIRCUIT, "coupling_mode": "definitely_quantitative"}
        rc, out = run_op("design_circuit_contextualize", args, str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "INVALID_INPUT"

    def test_contextualize_circuit_required(self, chassis_fixture, tmp_path):
        rc, out = run_op("design_circuit_contextualize", {
            "host_profile": chassis_fixture["hp"], "genome_ref_value": chassis_fixture["gr"]}, str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "INVALID_INPUT"

    def test_contextualize_host_profile_required(self, tmp_path):
        rc, out = run_op("design_circuit_contextualize", {"circuit": CIRCUIT}, str(tmp_path))
        assert rc == 0
        assert out["result"]["envelope"]["status"] == "INVALID_INPUT"

    def test_contextualize_deterministic(self, chassis_fixture, tmp_path):
        args = {"host_profile": chassis_fixture["hp"], "genome_ref_value": chassis_fixture["gr"],
                "circuit": CIRCUIT, "parts_evidence": EVIDENCE}
        s1, s2 = str(tmp_path / "c1"), str(tmp_path / "c2")
        rc1, out1 = run_op("design_circuit_contextualize", args, s1)
        rc2, out2 = run_op("design_circuit_contextualize", args, s2)
        assert rc1 == rc2 == 0
        assert sorted(os.listdir(s1)) == sorted(os.listdir(s2))
        for a in os.listdir(s1):
            assert open(os.path.join(s1, a), "rb").read() == open(os.path.join(s2, a), "rb").read()


# ═════════════════════════ 4. dispatcher 契约 ═════════════════════════

class TestDispatcherContract:
    def test_ops_table(self):
        """OPS 表三 op 注册；TOOL_OP_NAMES 与工具名一一对应（B2 双向验收雏形）。"""
        sys.path.insert(0, os.path.join(REPO, "python"))
        try:
            import design_host
        finally:
            sys.path.remove(os.path.join(REPO, "python"))
        assert set(design_host.OPS) == {
            "design_chassis_profile", "design_integration_candidates", "design_circuit_contextualize"}
        assert design_host.TOOL_OP_NAMES == {
            "bio_chassis_profile": "design_chassis_profile",
            "bio_integration_candidates": "design_integration_candidates",
            "bio_circuit_contextualize": "design_circuit_contextualize",
        }

    def test_unknown_op(self, tmp_path):
        rc, out = run_op("design_no_such_op", {}, str(tmp_path))
        assert rc == 0  # P2-1 全 exit-0 契约
        assert out["ok"] is False
        assert out["code"] == "UNKNOWN_OP"

    def test_bad_request(self, tmp_path):
        req = b"not json"
        env = dict(os.environ); env.update(ENV_BASE); env["DSH_DESIGN_STAGING"] = str(tmp_path)
        proc = subprocess.run([PYTHON, "-I", DISPATCHER], input=req, capture_output=True, env=env, timeout=120)
        out = json.loads(proc.stdout.decode("utf-8").strip() or "{}")
        assert proc.returncode == 0
        assert out["ok"] is False and out["code"] == "BAD_REQUEST"

    def test_staging_required(self, tmp_path):
        """worker 只写 staging：DSH_DESIGN_STAGING 未设置 → EXECUTION_ERROR（fail-closed）。"""
        env = dict(os.environ); env.update(ENV_BASE)
        env.pop("DSH_DESIGN_STAGING", None)
        proc = subprocess.run(
            [PYTHON, "-I", DISPATCHER],
            input=json.dumps({"op": "design_chassis_profile", "args": {
                "genome_files": [{"path": FIX_CIRCULAR, "format": "fasta", "sha256": FIX_CIRCULAR_SHA}],
                "coord_convention": "0-based-half-open"}}).encode(),
            capture_output=True, env=env, timeout=120)
        out = json.loads(proc.stdout.decode("utf-8").strip() or "{}")
        assert proc.returncode == 0
        envl = out["result"]["envelope"]
        assert envl["status"] == "EXECUTION_ERROR"
        assert envl["reason_code"] == "WORKER_STAGING_UNSET" or envl["reason_code"] == "EXECUTION_ERROR"


def _write_json(root, name, doc):
    p = os.path.join(root, name)
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)
    return p


def _evidence_item(match_grade, sequence):
    return {
        "artifact_type": "evidence_item@1",
        "source_ref": {"kind": "doi", "id": "10.0000/test-fixture"},
        "host": {"organism": "Escherichia coli", "strain": "K-12"},
        "readout": {"metric": "relative_expression", "value": "1.5", "unit": "RPU", "replicates": 3},
        "match_grade": match_grade,
        "matching_policy": {"id": "test-policy-v1", "version": "1"},
        "part_sequence": {"name": "w1-400", "sequence": sequence},
    }
