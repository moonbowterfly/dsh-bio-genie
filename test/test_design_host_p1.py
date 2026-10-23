# -*- coding: utf-8 -*-
"""fieldtest P1/P2 回归（design_host 侧）：注释截断重解析 + 必需性 id 命名空间。

覆盖（每条均为定向回归；旧实现下该断言为红）：
  R1 P1-2  host_profile.annotation.detail 被 2048 字节上限截断时，integration 不再一律
          NOT_RUN/ANNOTATION_TRUNCATED，而是从入参 genome_files 重解析**档案同一份**注释
          （sha256 集合逐项相等）后正常出候选；且候选命中落在 detail 保留段之外的特征
          （证明用的是完整重解析表，而非截断后的残留行）。
  R2 P1-2  fail-closed 保持：截断 + 未提供注释文件 → NOT_RUN/ANNOTATION_TRUNCATED；
          截断 + 换成另一份注释（哈希不匹配）→ BLOCKED/ANNOTATION_UNVERIFIABLE。
  R3 P2    必需性证据用裸 locus_tag（b0003）而注释 feature_id 为 gene-b0003（或反向）时，
          essentiality 规则必须 EXCLUDE（旧实现精确匹配 → 静默 PASS 假通过）。

入口：node scripts/run-python-test.mjs test/test_design_host_p1.py（非零退出即失败）。
"""
import hashlib
import json
import os
import random
import shutil
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "python"))
os.environ["DSH_DESIGN_PACKET_FIXED"] = os.path.join(REPO, "design", "packet")
os.environ["DSH_DESIGN_PACKET"] = ""
os.environ["DSH_DESIGN_EXPECT_INDEX_SHA"] = ""
os.environ["DSH_DESIGN_EXPECT_MANIFEST_SHA"] = ""
os.environ["DSH_DESIGN_ACCEPTANCE_ID"] = ""

import design_host  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + (" :: " + str(detail)[:400] if detail else ""))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run_op(op, args):
    """in-process 调用 OPS；返回统一结果（不抛异常，与 dispatcher 信封语义一致）。"""
    staging = tempfile.mkdtemp(prefix="dh-p1-stage-")
    os.environ["DSH_DESIGN_STAGING"] = staging
    try:
        res = design_host.OPS[op](args)
        env = res["result"]["envelope"]
        return {"threw": False, "status": env["status"], "reason": env["reason_code"],
                "detail": env.get("detail", ""), "artifacts": res["result"]["artifacts"],
                "staging": staging}
    except design_host.ToolError as exc:
        status = exc.code if exc.code in design_host.TOOL_STATES else "EXECUTION_ERROR"
        detail = exc.detail or ""
        reason = status
        head, sep, tail = detail.partition(":")
        if sep and head.strip() and all(ch.isupper() or ch == "_" for ch in head.strip()):
            reason = head.strip()
            detail = tail.strip()
        return {"threw": True, "status": status, "reason": reason, "detail": detail,
                "artifacts": [], "staging": staging}
    except Exception as exc:  # noqa: BLE001 — 复刻 dispatcher 的 WORKER_CRASH 语义（裸异常不得沉默）
        return {"threw": True, "status": "EXECUTION_ERROR", "reason": "WORKER_CRASH",
                "detail": "%s: %s" % (type(exc).__name__, exc), "artifacts": [], "staging": staging}


def read_artifact(result, logical_name):
    with open(os.path.join(result["staging"], logical_name), "rb") as fh:
        return json.loads(fh.read().decode("utf-8"))


def write_fasta(path, name, seq, width=70):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(">" + name + "\n")
        for i in range(0, len(seq), width):
            fh.write(seq[i:i + width] + "\n")


def synth_seq(length, seed):
    rnd = random.Random(seed)
    return "".join(rnd.choice("ACGT") for _ in range(length))


def stage_inputs(tmp, files):
    """把输入拷入 tmp/inputs（模拟 TS 摄入副本），返回 [{path, format, sha256}]。"""
    indir = os.path.join(tmp, "inputs")
    os.makedirs(indir, exist_ok=True)
    out = []
    for src, fmt in files:
        dst = os.path.join(indir, os.path.basename(src))
        if os.path.abspath(src) != os.path.abspath(dst):
            shutil.copyfile(src, dst)
        out.append({"path": dst, "format": fmt, "sha256": sha256_file(dst)})
    return out


# ───────────────────── R1/R2：P1-2 注释截断（真实规模特征表） ─────────────────────

TRUNC_CONTIG = "synth_linear_120000"
TRUNC_LEN = 120000
TRUNC_N_FEATURES = 60
TARGET_INDEX = 50          # 位于 detail 保留段（~24 行）之外
TARGET_FID = "gene-b%04d" % TARGET_INDEX


def build_truncated_fixture(root):
    """线性基因组 + 60 CDS 的 GFF3（detail 必被 2048 截断）。"""
    fasta = os.path.join(root, "genome.fna")
    gff = os.path.join(root, "genome.gff3")
    write_fasta(fasta, TRUNC_CONTIG, synth_seq(TRUNC_LEN, 20261016))
    with open(gff, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("##gff-version 3\n")
        for i in range(TRUNC_N_FEATURES):
            s = i * 1500
            e = s + 900
            strand = "+" if i % 2 == 0 else "-"
            fh.write("%s\tgenie\tCDS\t%d\t%d\t.\t%s\t.\tID=gene-b%04d;locus_tag=b%04d\n"
                     % (TRUNC_CONTIG, s + 1, e, strand, i, i))
    return fasta, gff


def target_window():
    s = TARGET_INDEX * 1500 + 100
    return {"contig": TRUNC_CONTIG, "start": s, "end": s + 200}


def test_annotation_truncation_is_reparseable(tmp):
    print("[R1] P1-2 截断注释 → 入参注释文件重解析（feature_overlap 命中 detail 保留段之外的特征）")
    fasta, gff = build_truncated_fixture(tmp)
    files = stage_inputs(tmp, [(fasta, "fasta"), (gff, "gff3")])
    chassis = run_op("design_chassis_profile", {
        "genome_files": files,
        "coord_convention": "0-based-half-open",
        "contig_topology": {TRUNC_CONTIG: "linear"},
    })
    check("chassis OK（前置）", chassis["status"] == "OK", chassis)
    hp = read_artifact(chassis, "host_profile.json")
    gr = read_artifact(chassis, "genome_ref.json")
    detail = hp["evidence_state"]["annotation"]["detail"]
    check("档案 annotation.detail 已被 2048 上限截断（截断前提成立）",
          '"truncated":true' in detail and len(detail) <= 2048, detail[:120])
    retained = json.loads(detail)["features"]
    check("detail 只保留部分特征行（真值 %d 条，保留 %d 条）"
          % (TRUNC_N_FEATURES, len(retained)), len(retained) < TRUNC_N_FEATURES,
          len(retained))

    base_args = {
        "host_profile": hp,
        "genome_ref_value": gr,
        "cassette": {"payload_length": 200},
        "candidates": [target_window()],
        "exclude_rules": ["repeat", "neighborhood", "motif"],
    }
    ok = run_op("design_integration_candidates", dict(base_args, genome_files=files))
    check("截断 + 同一份注释 → OK（旧实现此处 NOT_RUN/ANNOTATION_TRUNCATED）",
          ok["status"] == "OK", ok)
    check("产出 1 个候选", len(ok["artifacts"]) == 1, ok["artifacts"])
    if ok["status"] == "OK":
        cand = read_artifact(ok, "integration_candidate-01.json")
        reasons = {r["rule_id"]: r for r in cand["reasons"]}
        check("feature_overlap 判 EXCLUDE（依赖完整重解析表；只留残留行会 PASS）",
              reasons.get("feature_overlap", {}).get("code") == "EXCLUDE", cand["reasons"])
        check("命中特征为 %s（detail 保留段之外）" % TARGET_FID,
              reasons.get("feature_overlap", {}).get("detail", "").find(TARGET_FID) >= 0,
              reasons.get("feature_overlap"))
        check("候选分类 excluded（不得伪造成 screened_candidate）",
              cand["classification"] == "excluded", cand["classification"])

    # R2：未提供注释文件 → 保持 NOT_RUN/ANNOTATION_TRUNCATED（不放宽）
    no_ann = run_op("design_integration_candidates",
                    dict(base_args, genome_files=[files[0]]))
    check("截断 + 未提供注释文件 → NOT_RUN/ANNOTATION_TRUNCATED（fail-closed 保持）",
          no_ann["status"] == "NOT_RUN" and no_ann["reason"] == "ANNOTATION_TRUNCATED", no_ann)

    # R2：换成另一份注释（哈希不同）→ BLOCKED/ANNOTATION_UNVERIFIABLE（禁止换注释绕截断）
    other_gff = os.path.join(tmp, "other.gff3")
    with open(gff, encoding="utf-8") as fh:
        text = fh.read()
    with open(other_gff, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text + "%s\tgenie\tsynth\tCDS\t99901\t99999\t.\t+\t.\tID=gene-extra\n" % TRUNC_CONTIG)
    alt = stage_inputs(tmp, [(fasta, "fasta")]) + stage_inputs(tmp, [(other_gff, "gff3")])
    swapped = run_op("design_integration_candidates", dict(base_args, genome_files=alt))
    check("截断 + 注释文件哈希与档案不符 → BLOCKED/ANNOTATION_UNVERIFIABLE",
          swapped["status"] == "BLOCKED" and swapped["reason"] == "ANNOTATION_UNVERIFIABLE",
          swapped)


# ───────────────────── R3：P2 必需性 id 命名空间（禁静默假通过） ─────────────────────

NS_CONTIG = "synth_ns_20000"
NS_LEN = 20000


def build_namespace_fixture(root, feature_id):
    """线性基因组 + segments_tsv（feature_id 采用调用方指定的命名空间形态）。"""
    fasta = os.path.join(root, "ns.fna")
    tsv = os.path.join(root, "ns_features.tsv")
    write_fasta(fasta, NS_CONTIG, synth_seq(NS_LEN, 42))
    rows = [
        "feature_id\ttype\tstrand\tsegments\tlength\tnote",
        "%s\tCDS\t+\t1500-2300\t800\tsynthetic essential ORF" % feature_id,
        "geneZ\tCDS\t-\t5000-5600\t600\tsynthetic ORF",
    ]
    with open(tsv, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(rows) + "\n")
    return fasta, tsv


def run_namespace_case(tmp, feature_id, evidence_id, label):
    fasta, tsv = build_namespace_fixture(tmp, feature_id)
    files = stage_inputs(tmp, [(fasta, "fasta"), (tsv, "segments_tsv")])
    chassis = run_op("design_chassis_profile", {
        "genome_files": files,
        "coord_convention": "0-based-half-open",
        "contig_topology": {NS_CONTIG: "linear"},
    })
    if chassis["status"] != "OK":
        check("%s：chassis 前置 OK" % label, False, chassis)
        return
    hp = read_artifact(chassis, "host_profile.json")
    gr = read_artifact(chassis, "genome_ref.json")
    ess = os.path.join(tmp, "ess.json")
    with open(ess, "w", encoding="utf-8", newline="\n") as fh:
        json.dump({"genes": [evidence_id]}, fh)
    ess_in = stage_inputs(tmp, [(ess, "other")])[0]
    res = run_op("design_integration_candidates", {
        "host_profile": hp,
        "genome_ref_value": gr,
        "genome_files": files,
        "cassette": {"payload_length": 100},
        "candidates": [{"contig": NS_CONTIG, "start": 1600, "end": 1700}],
        "exclude_rules": ["repeat", "neighborhood", "motif"],
        "essentiality_evidence": {"path": ess_in["path"], "sha256": ess_in["sha256"]},
    })
    check("%s：integration OK（前置）" % label, res["status"] == "OK", res)
    if res["status"] != "OK":
        return
    cand = read_artifact(res, "integration_candidate-01.json")
    reasons = {r["rule_id"]: r for r in cand["reasons"]}
    ess_reason = reasons.get("essentiality", {})
    check("%s：essentiality 判 EXCLUDE（旧实现精确匹配 → 静默 PASS）" % label,
          ess_reason.get("code") == "EXCLUDE", ess_reason)
    check("%s：候选分类 excluded（不得因 id 不匹配而降级为候选）" % label,
          cand["classification"] == "excluded", cand["classification"])


def test_namespace_aliases(tmp):
    """P2 断言：裸 locus_tag 与命名空间形态互认（双向）。"""
    print("[R3] P2 必需性证据 id 命名空间互认")
    run_namespace_case(tmp, "gene-b0003", "b0003", "feature=gene-b0003/evidence=b0003")
    run_namespace_case(tmp, "b0003", "gene-b0003", "feature=b0003/evidence=gene-b0003")


# ───────────────── R4：P2 输入健壮性（genome_files 缺 sha256 不得崩） ─────────────────

def test_missing_sha256_is_computed(tmp):
    print("[R4] P2 genome_files 缺 sha256 → 由内容计算（旧实现 KeyError → WORKER_CRASH）")
    fasta = os.path.join(tmp, "nosha.fna")
    write_fasta(fasta, "synth_nosha_1000", synth_seq(1000, 7))
    res = run_op("design_chassis_profile", {
        "genome_files": [{"path": fasta, "format": "fasta"}],
        "coord_convention": "0-based-half-open",
    })
    check("缺 sha256 的 genome_files → OK（旧实现 KeyError → EXECUTION_ERROR/WORKER_CRASH）",
          res["status"] == "OK", res)
    if res["status"] == "OK":
        gr = read_artifact(res, "genome_ref.json")
        check("genome_ref.files[0].sha256 = 磁盘内容哈希（不得留空）",
              gr["files"][0]["sha256"] == sha256_file(fasta), gr["files"])


def main():
    root = tempfile.mkdtemp(prefix="dh-fieldtest-p1-")
    try:
        test_annotation_truncation_is_reparseable(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    sha_root = tempfile.mkdtemp(prefix="dh-fieldtest-sha-")
    try:
        test_missing_sha256_is_computed(sha_root)
    finally:
        shutil.rmtree(sha_root, ignore_errors=True)
    ns_root = tempfile.mkdtemp(prefix="dh-fieldtest-ns-")
    try:
        test_namespace_aliases(ns_root)
    finally:
        shutil.rmtree(ns_root, ignore_errors=True)
    print("\ndesign-host-p1: %d passed, %d failed" % (PASS, FAIL))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
