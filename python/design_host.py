#!/usr/bin/env python
"""design_host.py — host-side producer tools (B1P1): chassis_profile / integration_candidates / circuit_contextualize

规范源（版本链 v0.1→v0.6，sharespace）：
  - v0.1 §6.1–6.3（三工具方法/门禁/超时）
  - v0.2 §3.1/§5/§6（host 侧证据状态；ruleset 强制 + unknown_policy=block；
    cassette 序列/长度二分；coupling_mode 仅草案；kinetic_crn_ref@1 封装；禁绝对表达）
  - v0.2 §4.2 结果信封 {status, reason_code, artifact_refs[], detail}
  - v0.5 §D1 / v0.6 §E1 worker-output protocol：Python 只写 staging、只返回候选
    （bytes + 自报 hash）；TS 重读/重哈希/schema/登记/提交。

worker 输出协议（唯一）：
  stdin: {"op": <op>, "args": {...}}
  stdout: {"ok": true, "result": {"envelope": {...}, "artifacts": [
    {"logical_name", "staged", "sha256", "artifact_type"}]}}
  预期阻断（BLOCKED / NOT_RUN / DEPENDENCY_UNAVAILABLE / INVALID_INPUT）→ ok:true +
  显式 status 信封（v0.2 §4.2：预期阻断可为 ok:true）；硬错误 → ok:false。
  所有出口 exit 0（P2-1 全 exit-0 契约）。

确定性（R6）：无时间戳/随机；所有 artifact_id = sha256(canonical bytes)；
输出文件一律写 packet c14n canonical 字节（TS canonicalCheckViaPacket 逐字节判定）。
"""
import hashlib
import json
import os
import sys
import traceback

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
# -I（isolated）模式下脚本目录不进 sys.path；同目录的 design_validate 等模块需手动挂载
if HERE not in sys.path:
    sys.path.insert(0, HERE)
REPO_ROOT = os.path.dirname(HERE)
DEFAULT_RULESET = os.path.join(REPO_ROOT, "design", "integration-ruleset", "integration-ruleset-v0.json")

TOOL_STATES = ("OK", "BLOCKED", "NOT_RUN", "OUT_OF_DOMAIN", "DEPENDENCY_UNAVAILABLE", "INVALID_INPUT", "EXECUTION_ERROR")

# 条件字段（condition{} 完整度判定用核心集）
CONDITION_FIELDS = ("medium", "temperature", "oxygen", "phase")
# codon usage 输出条数
CODON_TOP_N = 12
# flank 长度（M2/M3 语义 oracle 冻结：60 nt）
FLANK_BP = 60


class ToolError(Exception):
    def __init__(self, code, detail=""):
        super().__init__(code)
        self.code = code
        self.detail = detail


# ───────────────────────── 基础 helpers ─────────────────────────

def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _canonical_json(obj):
    """诊断/内部哈希用排序 JSON（非 packet c14n；仅 detail/内部哈希）。"""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _packet_dir():
    from design_validate import PACKET_DIR
    return os.environ.get("DSH_DESIGN_PACKET_FIXED") or os.environ.get("DSH_DESIGN_PACKET") or PACKET_DIR


def _packet_ctx():
    """verified packet load + dispatch 身份绑定（split-packet 防线）。进程内缓存一次。"""
    if getattr(_packet_ctx, "_ctx", None) is not None:
        return _packet_ctx._ctx
    from design_validate import load_packet_context, verify_dispatch_identity
    packet_dir = _packet_dir()
    ctx, errs = load_packet_context(packet_dir)
    if ctx is None:
        detail = (errs[0].get("detail") if errs and isinstance(errs[0], dict) else "packet load failed") or "packet load failed"
        raise ToolError("DEPENDENCY_UNAVAILABLE", "PACKET_UNVERIFIED: %s" % str(detail)[:200])
    problems = verify_dispatch_identity(
        packet_dir,
        os.environ.get("DSH_DESIGN_EXPECT_INDEX_SHA") or None,
        os.environ.get("DSH_DESIGN_EXPECT_MANIFEST_SHA") or None,
        os.environ.get("DSH_DESIGN_ACCEPTANCE_ID") or None,
    )
    if problems:
        raise ToolError("DEPENDENCY_UNAVAILABLE", "PACKET_IDENTITY: " + "; ".join(problems)[:300])
    _packet_ctx._ctx = ctx
    return ctx


def _validate_artifact(stem, value):
    """仅 schema 校验（draft-07；不做 c14n——free-form 含数组的资产不可 canonicalize）。"""
    from design_validate import validate_with_ctx
    ctx = _packet_ctx()
    v = validate_with_ctx(ctx, stem, value)
    if not v["ok"]:
        first = v["errors"][0] if v["errors"] else {}
        raise ToolError("EXECUTION_ERROR", "schema invalid %s@1: %s@%s" % (stem, first.get("code"), first.get("path")))
    return v


def _canonical_artifact(stem, value):
    """schema 校验（写盘前第一道）+ packet c14n canonical 字节 + content sha。

    返回 (canonical_bytes, sha256hex)。校验失败 → ToolError(EXECUTION_ERROR)（fail-closed）。
    """
    from design_validate import canonicalize_bytes, validate_with_ctx
    ctx = _packet_ctx()
    v = validate_with_ctx(ctx, stem, value)
    if not v["ok"]:
        first = v["errors"][0] if v["errors"] else {}
        raise ToolError("EXECUTION_ERROR", "schema invalid %s@1: %s@%s" % (stem, first.get("code"), first.get("path")))
    text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    canon, _tree = canonicalize_bytes(ctx, stem, text, _packet_dir())
    return canon, hashlib.sha256(canon).hexdigest()


def _artifact_ref(sha, relative_path):
    return {"artifact_id": sha, "expected_sha256": sha, "relative_path": relative_path}


def _emit_candidates(staging_dir, artifacts):
    """把 artifact 列表写为 staging 候选（canonical 字节；logical_name 单段文件名）。

    artifacts: [{logical_name, stem, value}] → 返回 worker artifacts 自报表（含 sha）。
    """
    if not staging_dir:
        raise ToolError("EXECUTION_ERROR", "DSH_DESIGN_STAGING 未设置（worker 只写 staging）")
    if not os.path.isdir(staging_dir):
        raise ToolError("EXECUTION_ERROR", "staging dir missing: %s" % staging_dir)
    out = []
    for a in artifacts:
        canon, sha = _canonical_artifact(a["stem"], a["value"])
        path = os.path.join(staging_dir, a["logical_name"])
        with open(path, "wb") as fh:
            fh.write(canon)
        out.append({"logical_name": a["logical_name"], "staged": path, "sha256": sha, "artifact_type": a["stem"] + "@1"})
    return out


def _envelope(status, reason_code, detail, artifact_refs=None):
    return {
        "status": status,
        "reason_code": reason_code if reason_code else "OK",
        "artifact_refs": artifact_refs or [],
        "detail": detail or "",
    }


def _result(envelope, artifacts):
    return {"ok": True, "result": {"envelope": envelope, "artifacts": artifacts}}


def _verify_input_files(files, role_note):
    """门禁：文件存在 + 哈希一致（缺失/不符 → BLOCKED HASH_FAILED）。"""
    for f in files:
        path = f.get("path")
        want = f.get("sha256")
        if not path or not os.path.exists(path):
            raise ToolError("BLOCKED", "HASH_FAILED: %s 缺失（%s）" % (f.get("display_name") or path, role_note))
        actual = _sha256_file(path)
        if want and actual != want:
            raise ToolError("BLOCKED", "HASH_FAILED: %s 哈希不符 disk=%s expected=%s" % (f.get("display_name") or path, actual[:16], str(want)[:16]))


def _staging_dir():
    return os.environ.get("DSH_DESIGN_STAGING") or ""


# ───────────────────────── 序列/特征几何 ─────────────────────────

def parse_fasta(path):
    """Biopython 解析；重复 contig 名 → BLOCKED。返回 [{name, length, seq}]。"""
    from Bio import SeqIO
    contigs = []
    seen = set()
    for rec in SeqIO.parse(path, "fasta"):
        name = rec.id
        if not name:
            raise ToolError("EXECUTION_ERROR", "FASTA record without id: %s" % path)
        if name in seen:
            raise ToolError("BLOCKED", "DUPLICATE_CONTIG_NAME: %s" % name)
        seen.add(name)
        seq = str(rec.seq).upper()
        contigs.append({"name": name, "length": len(seq), "seq": seq})
    return contigs


def _one_based_to_zero(s, e):
    """1-based-inclusive → 0-based-half-open：start-1, end（end 含）。"""
    return s - 1, e


def parse_segments_tsv(path, declared_convention):
    """夹具特征表格式：feature_id,type,strand,segments('s-e;s-e'),length,note。"""
    features = []
    try:
        with open(path, encoding="utf-8") as fh:
            lines = [ln for ln in fh.read().splitlines() if ln.strip()]
    except OSError as exc:
        raise ToolError("EXECUTION_ERROR", "annotation unreadable: %s" % exc)
    if not lines:
        raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: empty segments_tsv")
    header = lines[0].split("\t")
    if header[:5] != ["feature_id", "type", "strand", "segments", "length"]:
        raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: segments_tsv header mismatch")
    for lineno, ln in enumerate(lines[1:], 2):
        cols = ln.split("\t")
        if len(cols) < 6:
            raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: segments_tsv line %d malformed" % lineno)
        fid, ftype, strand, segs_s, _length, note = cols[0], cols[1], cols[2], cols[3], cols[4], cols[5]
        if not fid or not ftype or strand not in ("+", "-", "."):
            raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: segments_tsv line %d fields" % lineno)
        segs = []
        for part in segs_s.split(";"):
            if "-" not in part:
                raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: segments_tsv line %d segments" % lineno)
            s_str, e_str = part.split("-", 1)
            try:
                s, e = int(s_str), int(e_str)
            except ValueError:
                raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: segments_tsv line %d coords" % lineno)
            if declared_convention == "1-based-inclusive":
                s, e = _one_based_to_zero(s, e)
            if not (0 <= s < e):
                raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: segments_tsv line %d invalid segment" % lineno)
            segs.append([s, e])
        features.append({"feature_id": fid, "type": ftype, "strand": strand, "segments": segs, "note": note})
    return features


def parse_gff3(path, declared_convention):
    """最小 GFF3 解析（## 行忽略；9 列；start/end 按声明 convention 转换；contig=seqid）。"""
    features = []
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError as exc:
        raise ToolError("EXECUTION_ERROR", "annotation unreadable: %s" % exc)
    for lineno, ln in enumerate(lines, 1):
        if not ln.strip() or ln.startswith("#"):
            continue
        cols = ln.split("\t")
        if len(cols) < 9:
            raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: gff3 line %d columns=%d" % (lineno, len(cols)))
        seqid, _src, ftype, start_s, end_s, _score, strand, _phase, attrs = cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], cols[6], cols[7], cols[8]
        try:
            s, e = int(start_s), int(end_s)
        except ValueError:
            raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: gff3 line %d coords" % lineno)
        if declared_convention == "1-based-inclusive":
            s, e = _one_based_to_zero(s, e)
        if not (0 <= s < e):
            raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: gff3 line %d invalid interval" % lineno)
        if strand not in ("+", "-", "."):
            raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: gff3 line %d strand" % lineno)
        fid = _gff_feature_id(attrs, seqid, ftype, lineno)
        features.append({"feature_id": fid, "type": ftype, "strand": strand, "segments": [[s, e]], "note": "",
                         "contig": seqid})
    return features


def _gff_feature_id(attrs, seqid, ftype, lineno):
    kv = {}
    for token in attrs.split(";"):
        if "=" in token:
            k, _, v = token.partition("=")
            kv[k.strip()] = v.strip()
    for key in ("ID", "locus_tag", "gene", "Name"):
        if kv.get(key):
            return kv[key]
    return "%s:%s:%d" % (seqid, ftype, lineno)


def parse_genbank(path):
    """Biopython GenBank 解析；feature location（0-based）按 parts 展开（跨原点特征多段）。"""
    from Bio import SeqIO
    features = []
    try:
        records = list(SeqIO.parse(path, "genbank"))
    except Exception as exc:  # noqa: BLE001
        raise ToolError("EXECUTION_ERROR", "ANNOTATION_UNTRUSTED: genbank parse: %s" % str(exc)[:200])
    for rec in records:
        for i, feat in enumerate(rec.features):
            ftype = feat.type or "other"
            if ftype in ("source", "gene"):
                continue
            loc = feat.location
            if loc is None:
                continue
            parts = []
            try:
                if hasattr(loc, "parts") and loc.parts:
                    for p in loc.parts:
                        parts.append([int(p.start), int(p.end)])
                else:
                    parts.append([int(loc.start), int(loc.end)])
            except Exception:  # noqa: BLE001
                continue
            if not parts:
                continue
            strand = "+" if (feat.strand or 1) > 0 else "-"
            qual = feat.qualifiers or {}
            fid = None
            for key in ("locus_tag", "gene", "label", "product"):
                if qual.get(key):
                    fid = str(qual[key][0])
                    break
            if not fid:
                fid = "%s:gb:%d" % (rec.id, i)
            features.append({"feature_id": fid, "type": ftype, "strand": strand, "segments": parts, "note": "",
                             "contig": rec.id})
    return features


def parse_annotation(path, fmt, declared_convention):
    if fmt == "segments_tsv":
        return parse_segments_tsv(path, declared_convention)
    if fmt == "gff3":
        return parse_gff3(path, declared_convention)
    if fmt == "genbank":
        return parse_genbank(path)
    raise ToolError("INVALID_INPUT", "unsupported annotation format: %s" % fmt)


def take_circle(seq, start, length):
    """从 start 取 length 字符（可环绕）。"""
    L = len(seq)
    if L == 0:
        return ""
    start %= L
    out = seq[start:start + length]
    if len(out) < length:
        out += seq[:length - len(out)]
    return out


def unwrap_intervals(L, topology, segments):
    """把 0-based 段集合转为不环绕线性区间集（circular → [0,2L) 域双拷贝；linear → 原样）。"""
    out = []
    for s, e in segments:
        if topology == "circular":
            out.append([s, e + L])
            out.append([s + L, e + 2 * L])
        else:
            out.append([s, e])
    return out


def expand_intervals(intervals, w, domain_hi):
    out = []
    for s, e in intervals:
        a, b = max(0, s - w), min(domain_hi, e + w)
        if b > a:
            out.append([a, b])
    return out


def overlap_nt(intervals_a, intervals_b):
    total = 0
    for a_s, a_e in intervals_a:
        for b_s, b_e in intervals_b:
            lo, hi = max(a_s, b_s), min(a_e, b_e)
            if hi > lo:
                total += hi - lo
    return total


def find_repeat_unit(locus_seq, min_len):
    """ab-initio 重复检测：长度 >= min_len 的 unit 出现 >=2 次 → (unit_len, pos_a, pos_b)。"""
    n = len(locus_seq)
    for u in range(min_len, n // 2 + 1):
        seen = {}
        for i in range(0, n - u + 1):
            sub = locus_seq[i:i + u]
            if sub in seen:
                return u, seen[sub], i
            seen[sub] = i
    return None


def revcomp(seq):
    return seq.translate(str.maketrans("ACGT", "TGCA"))[::-1]


# ───────────────────────── 6.1 design_chassis_profile ─────────────────────────

def op_design_chassis_profile(args):
    """bio_chassis_profile：FASTA 必填（GFF/GB/segments_tsv 可选）→ genome_ref@1 + host_profile@1。

    门禁：文件哈希必须成功（BLOCKED HASH_FAILED）；坐标体系未声明（BLOCKED
    COORD_CONVENTION_UNDECLARED）；重复 contig 名（BLOCKED DUPLICATE_CONTIG_NAME）。
    输出宿主侧证据状态（不声明产品档位；不含 GEM growth 锚点——v0.2 §6.1 / v3 §A0.5）。
    """
    genome_files = args.get("genome_files")
    if not isinstance(genome_files, list) or not genome_files:
        raise ToolError("INVALID_INPUT", "genome_files[] 必填")
    if not any(isinstance(f, dict) and f.get("format") == "fasta" for f in genome_files):
        raise ToolError("INVALID_INPUT", "FASTA 必填（genome_files 至少一个 format=fasta）")
    _verify_input_files(genome_files, "genome input")
    coord = args.get("coord_convention")
    if coord not in ("0-based-half-open", "1-based-inclusive"):
        raise ToolError("BLOCKED", "COORD_CONVENTION_UNDECLARED: 坐标体系必须显式声明")

    contig_topology = args.get("contig_topology") or {}
    if not isinstance(contig_topology, dict):
        raise ToolError("INVALID_INPUT", "contig_topology 必须为对象")

    # ── FASTA 解析（含重复 contig 门禁；跨文件同名 contig 同样拦截）──
    contigs = []
    seen_names = set()
    for f in genome_files:
        if f.get("format") != "fasta":
            continue
        for c in parse_fasta(f["path"]):
            if c["name"] in seen_names:
                raise ToolError("BLOCKED", "DUPLICATE_CONTIG_NAME: %s" % c["name"])
            seen_names.add(c["name"])
            contigs.append(c)
    contig_seqs = {c["name"]: c["seq"] for c in contigs}

    # ── 注释解析（可选；解析失败 → 注释不可信，fail-closed）──
    annotation_files = [f for f in genome_files if f.get("format") in ("gff3", "genbank", "segments_tsv")]
    all_features = []
    annotation_untrusted = False
    for f in annotation_files:
        try:
            feats = parse_annotation(f["path"], f["format"], coord)
        except ToolError as exc:
            if exc.code == "EXECUTION_ERROR":
                annotation_untrusted = True
                continue
            raise
        all_features.extend(feats)

    # 特征 contig 归属：segments_tsv 无 contig 列 → 单 contig 夹具直接归属；多 contig 无法归属 → 不可信
    bound_features = []
    for feat in all_features:
        if feat.get("contig") is not None:
            bound_features.append(feat)
        elif len(contigs) == 1:
            feat = dict(feat)
            feat["contig"] = contigs[0]["name"]
            bound_features.append(feat)
        else:
            annotation_untrusted = True
    all_features = bound_features

    covered_contigs = {feat["contig"] for feat in all_features if feat["contig"] in contig_seqs}
    if not annotation_files:
        annotation_completeness = "missing"
    elif annotation_untrusted:
        annotation_completeness = "partial"
    else:
        annotation_completeness = "full" if covered_contigs == set(contig_seqs) else "partial"

    # 特征表 → annotation.detail（紧凑 JSON；超 2048 截断并标记 truncated）
    essential_ids = []
    for feat in all_features:
        note = feat.get("note") or ""
        if "essential_candidate=true" in note or "gene_essential=true" in note:
            essential_ids.append(feat["feature_id"])
    feature_rows = [{"f": feat["feature_id"], "t": feat["type"], "s": feat["strand"],
                     "g": feat["segments"], "c": feat["contig"]} for feat in all_features]
    ann_summary = {
        "features": feature_rows,
        "truncated": False,
        "untrusted": annotation_untrusted,
        "essential_candidate_ids": sorted(set(essential_ids)),
        "contig_coverage": {"covered": len(covered_contigs), "total": len(contigs)},
    }
    ann_json = _canonical_json(ann_summary)
    if len(ann_json) > 2048:
        ann_summary["truncated"] = True
        base_budget = len(_canonical_json({k: v for k, v in ann_summary.items() if k != "features"}))
        budget = 2048 - base_budget - 32
        rows = []
        used = 0
        for row in feature_rows:
            row_json = _canonical_json(row)
            if used + len(row_json) + 2 > budget:
                break
            rows.append(row)
            used += len(row_json) + 2
        ann_summary["features"] = rows
        ann_json = _canonical_json(ann_summary)

    # ── 派生统计 ──
    genome_size = sum(c["length"] for c in contigs)
    total_bp = sum(len(seq) for seq in contig_seqs.values())
    total_gc = sum(seq.count("G") + seq.count("C") for seq in contig_seqs.values())
    gc_percent = round(100.0 * total_gc / total_bp, 6) if total_bp else 0.0

    # codon usage：有 CDS 注释 → 从 CDS 提取；否则 +1 frame
    cds_features = [feat for feat in all_features if feat["type"] == "CDS"]
    codon_counts = {}
    if cds_features:
        for feat in cds_features:
            seq = contig_seqs.get(feat.get("contig"))
            if seq is None:
                continue
            pieces = []
            for s, e in feat["segments"]:
                pieces.append(take_circle(seq, s, e - s))
            coding = "".join(pieces)
            if feat["strand"] == "-":
                coding = revcomp(coding)
            for i in range(0, len(coding) - 2, 3):
                codon_counts[coding[i:i + 3]] = codon_counts.get(coding[i:i + 3], 0) + 1
    else:
        for name, seq in contig_seqs.items():
            for i in range(0, len(seq) - 2, 3):
                codon_counts[seq[i:i + 3]] = codon_counts.get(seq[i:i + 3], 0) + 1
    total_codons = sum(codon_counts.values()) or 1
    codon_usage_top = sorted(
        [{"codon": c, "fraction": round(n / total_codons, 8)} for c, n in codon_counts.items()],
        key=lambda x: (-x["fraction"], x["codon"]),
    )[:CODON_TOP_N]

    # ── genome_ref@1（files.format 取 frozen 枚举：fasta|genbank|gff3|other）──
    _GB_FORMAT = {"fasta": "fasta", "genbank": "genbank", "gff3": "gff3"}
    display_files = []
    for f in genome_files:
        display_files.append({
            "path": f.get("display_name") or os.path.basename(f.get("path", "")),
            "sha256": f["sha256"],
            "format": _GB_FORMAT.get(f.get("format", ""), "other"),
        })
    genome_ref_value = {
        "artifact_type": "genome_ref@1",
        "files": display_files,
        "contigs": [{"name": c["name"], "length": c["length"],
                     "topology": contig_topology.get(c["name"], "linear")} for c in contigs],
        "coord_convention": coord,
        "source": args.get("genome_source") or "user-supplied-genome",
    }

    # ── host_profile@1 ──
    condition = args.get("condition")
    if condition is None:
        condition = {}
    if not isinstance(condition, dict):
        raise ToolError("INVALID_INPUT", "condition 必须为对象（可空字段显式 null）")
    present_cond = [k for k in CONDITION_FIELDS if condition.get(k) is not None]
    if len(present_cond) == len(CONDITION_FIELDS):
        cond_completeness = "full"
    elif present_cond:
        cond_completeness = "partial"
    else:
        cond_completeness = "missing"
    cond_detail = "fields=" + (",".join(sorted(present_cond)) if present_cond else "none")

    parts_evidence_file = args.get("parts_evidence_file")
    pe_completeness = "missing"
    pe_source = None
    pe_hash = None
    pe_levels = []
    pe_detail = "no parts evidence file"
    if isinstance(parts_evidence_file, dict) and parts_evidence_file.get("path"):
        _verify_input_files([parts_evidence_file], "parts evidence")
        pe_hash = parts_evidence_file["sha256"]
        pe_source = parts_evidence_file.get("display_name") or os.path.basename(parts_evidence_file["path"])
        try:
            with open(parts_evidence_file["path"], encoding="utf-8") as fh:
                raw = fh.read()
        except OSError as exc:
            raise ToolError("BLOCKED", "HASH_FAILED: parts evidence unreadable: %s" % exc)
        doc = None
        try:
            doc = json.loads(raw)
        except ValueError:
            doc = None
        if isinstance(doc, dict) and isinstance(doc.get("levels"), list):
            levels = [str(x) for x in doc["levels"] if str(x) in ("E0", "E1", "E2", "E3")]
            pe_levels = sorted(set(levels))
            pe_source = doc.get("source_id") or pe_source
        if pe_levels:
            pe_completeness = "full"
            pe_detail = "levels=" + ",".join(pe_levels)
        elif doc is not None:
            pe_completeness = "partial"
            pe_detail = "parts evidence 文件存在但无有效 levels"
        else:
            pe_completeness = "partial"
            pe_detail = "parts evidence 文件存在但不可解析（非 JSON/无 levels）"

    genome_ref_sha = _canonical_artifact("genome_ref", genome_ref_value)[1]

    host_profile_value = {
        "artifact_type": "host_profile@1",
        "genome_ref": _artifact_ref(genome_ref_sha, "genome_ref.json"),
        "evidence_state": {
            "annotation": {"completeness": annotation_completeness, "detail": ann_json},
            "condition": {"completeness": cond_completeness, "detail": cond_detail},
            "parts_evidence": {
                "completeness": pe_completeness,
                **( {"source_id": pe_source} if pe_source else {}),
                **( {"hash": pe_hash} if pe_hash else {}),
                **( {"levels": pe_levels} if pe_levels else {}),
                "detail": pe_detail,
            },
        },
        "derived": {
            "genome_size": genome_size,
            "gc_percent": gc_percent,
            "contig_count": len(contigs),
            "codon_usage_top": codon_usage_top,
        },
        "gates": [
            {"gate": "file_hash", "status": "PASS"},
            {"gate": "coordinate_convention_declared", "status": "PASS"},
            {"gate": "contig_names_unique", "status": "PASS"},
            {"gate": "genome_parse", "status": "PASS"},
            {"gate": "annotation_parse",
             "status": "FAIL" if annotation_untrusted else ("PASS" if annotation_files else "SKIP"),
             **( {"detail": "annotation parse failed; annotation marked untrusted"} if annotation_untrusted else {})},
        ],
    }

    host_profile_sha = _canonical_artifact("host_profile", host_profile_value)[1]
    staging = _staging_dir()
    artifacts = _emit_candidates(staging, [
        {"logical_name": "genome_ref.json", "stem": "genome_ref", "value": genome_ref_value},
        {"logical_name": "host_profile.json", "stem": "host_profile", "value": host_profile_value},
    ])
    envelope = _envelope(
        "OK", "OK",
        "host profile computed: contigs=%d genome_size=%d gc_percent=%s annotation=%s"
        % (len(contigs), genome_size, gc_percent, annotation_completeness),
        [_artifact_ref(genome_ref_sha, "genome_ref.json"), _artifact_ref(host_profile_sha, "host_profile.json")],
    )
    return _result(envelope, artifacts)


# ───────────────────────── 6.2 design_integration_candidates ─────────────────────────

def _load_host_profile(args):
    """host_profile 输入（值或 ref 二选一；ref 必须与 canonical sha 一致 → INVALID_INPUT）。"""
    hp = args.get("host_profile")
    ref = args.get("host_profile_ref")
    if isinstance(ref, dict) and ref.get("artifact_id") and not isinstance(hp, dict):
        raise ToolError("INVALID_INPUT", "host_profile_ref 仅支持 TS 解析后的嵌入值（本层不读路径）")
    if not (isinstance(hp, dict) and hp.get("artifact_type") == "host_profile@1"):
        raise ToolError("INVALID_INPUT", "host_profile 必须为 host_profile@1 对象")
    _canonical_artifact("host_profile", hp)
    sha = _canonical_artifact("host_profile", hp)[1]
    if isinstance(ref, dict) and ref.get("artifact_id") and ref.get("artifact_id") != sha:
        raise ToolError("INVALID_INPUT", "HOST_PROFILE_REF_MISMATCH: ref artifact_id != canonical sha")
    # genome_ref 值（host_profile.genome_ref 为 artifactRef；值由 TS 层随调用传入）
    gr = args.get("genome_ref_value")
    if not (isinstance(gr, dict) and gr.get("artifact_type") == "genome_ref@1"):
        raise ToolError("INVALID_INPUT", "genome_ref_value 必须为 genome_ref@1 对象（随 host_profile 传入）")
    gr_sha = _canonical_artifact("genome_ref", gr)[1]
    hp_gr = hp.get("genome_ref")
    if isinstance(hp_gr, dict) and hp_gr.get("artifact_id") and hp_gr.get("artifact_id") != gr_sha:
        raise ToolError("INVALID_INPUT", "GENOME_REF_REF_MISMATCH: host_profile.genome_ref 与 genome_ref_value 不一致")
    return hp, sha, gr


def _load_ruleset(args):
    """integration_ruleset 资产强制消费（R2）：路径参数优先，缺省正式资产；缺失/损坏 → BLOCKED。"""
    path = args.get("ruleset_path") or DEFAULT_RULESET
    if not path or not os.path.exists(path):
        raise ToolError("BLOCKED", "RULESET_UNAVAILABLE: integration-ruleset 资产缺失")
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as exc:
        raise ToolError("BLOCKED", "RULESET_UNAVAILABLE: 资产不可解析: %s" % str(exc)[:200])
    if not (isinstance(doc, dict) and doc.get("artifact_type") == "integration_ruleset@1"):
        raise ToolError("BLOCKED", "RULESET_UNAVAILABLE: 非 integration_ruleset@1")
    # 结构校验走 packet schema（draft-07；params 为 free-form，无需 c14n 注解）
    _validate_artifact("integration_ruleset", doc)
    # artifact_id = 资产文件字节 sha256（ruleset 为仓库注册资产，非 case 内 packet-c14n 产物；
    # params 含 free-form 数组，packet c14n 会拒绝未注解数组——禁用其 canonical 哈希）
    sha = _sha256_file(path)
    rules = doc.get("rules")
    if not isinstance(rules, list) or not rules:
        raise ToolError("BLOCKED", "RULESET_UNAVAILABLE: 空 rules")
    by_id = {}
    for r in rules:
        if not isinstance(r, dict) or not isinstance(r.get("rule_id"), str):
            raise ToolError("BLOCKED", "RULESET_UNAVAILABLE: malformed rule entry")
        by_id[r["rule_id"]] = r
    return doc, sha, by_id


def _load_cassette(args):
    """cassette{length_or_file}：sequence / payload_length 至少其一；序列/长度不一致 → INVALID_INPUT。"""
    cassette = args.get("cassette")
    if not isinstance(cassette, dict):
        raise ToolError("INVALID_INPUT", "cassette 必填")
    sequence = cassette.get("sequence")
    payload_length = cassette.get("payload_length")
    seq_sha = cassette.get("sequence_sha256")
    if isinstance(sequence, str) and sequence:
        if not isinstance(seq_sha, str) or len(seq_sha) != 64:
            seq_sha = hashlib.sha256(sequence.encode("utf-8")).hexdigest()
        elif seq_sha != hashlib.sha256(sequence.encode("utf-8")).hexdigest():
            raise ToolError("INVALID_INPUT", "cassette.sequence_sha256 与 sequence 不一致")
        if payload_length is not None and payload_length != len(sequence):
            raise ToolError("INVALID_INPUT", "cassette.payload_length 与 sequence 长度不一致")
        payload_length = len(sequence)
        identity = "known"
    elif payload_length is not None and isinstance(payload_length, int) and payload_length > 0:
        identity = "unknown"
    else:
        raise ToolError("INVALID_INPUT", "cassette 需提供 sequence 或 payload_length（长度二分语义）")
    return {
        "sequence_identity": identity,
        "sequence": sequence,
        "sequence_sha256": seq_sha if identity == "known" else None,
        "payload_length": payload_length,
    }


def _load_json_evidence(args, key):
    """可选证据 JSON 文件（essentiality / expression）→ dict；文件损坏 → INVALID_INPUT。"""
    spec = args.get(key)
    if spec is None:
        return None
    if not isinstance(spec, dict) or not spec.get("path"):
        raise ToolError("INVALID_INPUT", "%s 必须为 {path, sha256, ...}" % key)
    _verify_input_files([spec], key)
    try:
        with open(spec["path"], encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as exc:
        raise ToolError("INVALID_INPUT", "%s 不可解析: %s" % (key, str(exc)[:200]))
    if not isinstance(doc, dict):
        raise ToolError("INVALID_INPUT", "%s 必须为对象" % key)
    return doc


def _evidence_ids(doc, key):
    """证据文件 → 基因 id 集合（对象键 genes / gene_ids / 裸 list 均可）。"""
    for k in ("genes", "gene_ids", "essential_genes", "high_expression_genes"):
        if isinstance(doc.get(k), list):
            return set(str(x) for x in doc[k] if str(x))
    if isinstance(doc.get("ids"), list):
        return set(str(x) for x in doc["ids"] if str(x))
    raise ToolError("INVALID_INPUT", "%s 缺基因列表（genes/gene_ids/ids）" % key)


def _parse_candidates_input(args, contigs_by_name, topology_by_name):
    """候选窗口输入：candidates[] 或 scan（互斥）；返回 [(contig, segments, ordering_key)]。"""
    explicit = args.get("candidates")
    scan = args.get("scan")
    if explicit is not None and scan is not None:
        raise ToolError("INVALID_INPUT", "candidates 与 scan 互斥")
    out = []
    if isinstance(explicit, list):
        for i, c in enumerate(explicit):
            if not (isinstance(c, dict) and isinstance(c.get("contig"), str)
                    and isinstance(c.get("start"), int) and isinstance(c.get("end"), int)):
                raise ToolError("INVALID_INPUT", "candidates[%d] 需 {contig, start, end}" % i)
            contig = c["contig"]
            L = contigs_by_name.get(contig)
            if L is None:
                raise ToolError("INVALID_INPUT", "candidates[%d] contig 不存在: %s" % (i, contig))
            s, e = c["start"], c["end"]
            if s < 0 or e < 0:
                raise ToolError("INVALID_INPUT", "candidates[%d] 非法区间" % i)
            if topology_by_name.get(contig) == "circular":
                if e > L:
                    segs = [[s, L], [0, e - L]]
                elif e < s and s < L:
                    # 跨 origin 显式窗口（end < start 语义：绕环回到 start 之后）
                    segs = [[s, L], [0, e]]
                elif e <= s:
                    raise ToolError("INVALID_INPUT", "candidates[%d] 非法区间" % i)
                else:
                    segs = [[s, e]]
            else:
                if e <= s or e > L:
                    raise ToolError("INVALID_INPUT", "candidates[%d] 线性 contig 越界/非法区间" % i)
                segs = [[s, e]]
            out.append((contig, segs, (contig, s)))
        return out
    if scan is not None:
        if not isinstance(scan, bool):
            raise ToolError("INVALID_INPUT", "scan 必须为布尔")
        if not scan:
            raise ToolError("INVALID_INPUT", "candidates 或 scan=true 必选其一")
        return None  # 哨兵：调用方按 payload 扫描
    raise ToolError("INVALID_INPUT", "candidates 或 scan=true 必选其一")


def _point_distance_to_position(topo, L, pos, point):
    """点到 pos 的距离：circular 取环状最小距离；linear 取绝对距离。"""
    if topo == "circular":
        fwd = (point - pos) % L
        return min(fwd, L - fwd)
    return abs(point - pos)


def _circular_distance_to_point(topo, L, segs, pos):
    """窗口到 pos 的距离（各段端点距离取 min）。"""
    best = None
    for s, e in segs:
        for p in (s, e):
            d = _point_distance_to_position(topo, L, pos, p)
            if best is None or d < best:
                best = d
    return best


def _locus_sequence(L, topology, segments, seq):
    """按段集合取窗口序列（circular 环绕）。"""
    if topology == "circular":
        return "".join(take_circle(seq, s, e - s) for s, e in segments)
    return "".join(seq[s:e] for s, e in segments)


def op_design_integration_candidates(args):
    """bio_integration_candidates：host_profile + cassette → integration_candidate@1[]（≤top_n）。

    门禁：无注释/注释不可信 → NOT_RUN；ruleset 资产缺失 → BLOCKED；环状跨 origin 显式处理；
    不得输出 safe 分类。ruleset 强制：unknown_policy=block（未知注释/重复/必需性不得默认为通过）。
    """
    host_profile, _hp_sha, genome_ref_value = _load_host_profile(args)
    ruleset, ruleset_sha, rules_by_id = _load_ruleset(args)

    # ── 注释状态 → 位点类门禁 ──
    ev_state = host_profile.get("evidence_state") or {}
    ann_state = ev_state.get("annotation") or {}
    ann_completeness = ann_state.get("completeness", "missing")
    ann_detail = ann_state.get("detail") or ""
    ann_obj = None
    try:
        ann_obj = json.loads(ann_detail)
    except (ValueError, TypeError):
        ann_obj = None
    if not isinstance(ann_obj, dict):
        raise ToolError("BLOCKED", "ANNOTATION_UNVERIFIABLE: host_profile.annotation.detail 不可解析")
    ann_untrusted = ann_obj.get("untrusted") is True
    if ann_completeness == "missing":
        raise ToolError("NOT_RUN", "NO_ANNOTATION: 宿主档案注释缺失（位点类工具不运行）")
    if ann_untrusted:
        raise ToolError("NOT_RUN", "ANNOTATION_UNTRUSTED: 注释解析失败/不可信（位点类工具不运行）")

    # ── 基因组文件 + genome_ref 一致性 ──
    genome_files = args.get("genome_files")
    if not isinstance(genome_files, list) or not genome_files:
        raise ToolError("INVALID_INPUT", "genome_files[] 必填（FASTA 序列）")
    _verify_input_files(genome_files, "genome input")
    contigs = []
    for f in genome_files:
        if f.get("format") == "fasta":
            contigs.extend(parse_fasta(f["path"]))
    if not contigs:
        raise ToolError("INVALID_INPUT", "FASTA 必填（genome_files 至少一个 format=fasta）")
    contig_seqs = {c["name"]: c["seq"] for c in contigs}
    gr_contigs = genome_ref_value.get("contigs") or []
    ref_shape = {(c.get("name"), c.get("length")) for c in gr_contigs}
    disk_shape = {(c["name"], c["length"]) for c in contigs}
    if ref_shape != disk_shape:
        raise ToolError("INVALID_INPUT", "GENOME_REF_MISMATCH: FASTA contigs 与 genome_ref 不一致")
    topology_by_name = {c.get("name"): c.get("topology", "linear") for c in gr_contigs}

    # ── 特征表（从 host_profile annotation detail 反解；规则评估用）──
    if not isinstance(ann_obj.get("features"), list):
        raise ToolError("BLOCKED", "ANNOTATION_UNVERIFIABLE: host_profile.annotation.detail 不可反解特征表")
    features = []
    for row in ann_obj["features"]:
        if not (isinstance(row, dict) and isinstance(row.get("f"), str) and isinstance(row.get("t"), str)
                and isinstance(row.get("g"), list) and isinstance(row.get("c"), str)
                and row.get("s") in ("+", "-", ".")):
            raise ToolError("BLOCKED", "ANNOTATION_UNVERIFIABLE: 特征行损坏")
        features.append({"feature_id": row["f"], "type": row["t"], "strand": row["s"],
                         "segments": row["g"], "contig": row["c"]})
    if ann_obj.get("truncated"):
        raise ToolError("NOT_RUN", "ANNOTATION_TRUNCATED: 档案注释摘要截断（位点类工具不运行）")

    # ── 规则参数（正式资产驱动；固定求值顺序）──
    exclude_rules = args.get("exclude_rules")
    if exclude_rules is None:
        exclude_rules = []
    if not isinstance(exclude_rules, list) or any(not isinstance(x, str) for x in exclude_rules):
        raise ToolError("INVALID_INPUT", "exclude_rules 必须为 rule_id 列表")
    unknown_excl = [x for x in exclude_rules if x not in rules_by_id]
    if unknown_excl:
        raise ToolError("INVALID_INPUT", "exclude_rules 含未知 rule_id: %s" % ",".join(unknown_excl))
    exclude_set = set(exclude_rules)

    rule_order = []
    for r in ruleset["rules"]:
        if r["rule_id"] not in exclude_set:
            rule_order.append(r["rule_id"])

    def params_of(rule_id):
        p = rules_by_id[rule_id].get("params")
        return p if isinstance(p, dict) else {}

    # ── cassette + 候选输入 ──
    cassette = _load_cassette(args)
    top_n = args.get("top_n")
    if top_n is None:
        top_n = 20
    if not isinstance(top_n, int) or top_n < 1:
        raise ToolError("INVALID_INPUT", "top_n 必须为正整数")
    parsed = _parse_candidates_input(args, {c["name"]: c["length"] for c in contigs}, topology_by_name)
    if parsed is None:
        payload = cassette["payload_length"]
        windows = []
        for contig in [c["name"] for c in contigs]:
            L = contig_seqs[contig]
            topo = topology_by_name.get(contig, "linear")
            if topo == "circular":
                for i in range(0, L, payload):
                    if i + payload <= L:
                        windows.append((contig, [[i, i + payload]], (contig, i)))
                    else:
                        windows.append((contig, [[i, L], [0, i + payload - L]], (contig, i)))
            else:
                for i in range(0, max(0, L - payload) + 1, payload):
                    windows.append((contig, [[i, i + payload]], (contig, i)))
        windows = windows[:top_n * 16]  # 扫描空间上限（避免超大基因组全扫）
    else:
        windows = parsed

    # ── 证据 ──
    essentiality_doc = _load_json_evidence(args, "essentiality_evidence")
    expression_doc = _load_json_evidence(args, "expression_evidence")
    essential_ids = _evidence_ids(essentiality_doc, "essentiality_evidence") if essentiality_doc is not None else None
    high_exp_ids = _evidence_ids(expression_doc, "expression_evidence") if expression_doc is not None else None
    origin_positions = args.get("origin_positions")
    if origin_positions is None:
        origin_positions = {}
    if not isinstance(origin_positions, dict):
        raise ToolError("INVALID_INPUT", "origin_positions 必须为 {contig: pos}")

    evidence_items = args.get("evidence_items")
    if evidence_items is None:
        evidence_items = []
    if not isinstance(evidence_items, list):
        raise ToolError("INVALID_INPUT", "evidence_items 必须为列表")
    lit_items = []
    for ei in evidence_items:
        if not (isinstance(ei, dict) and ei.get("artifact_type") == "evidence_item@1"):
            raise ToolError("INVALID_INPUT", "evidence_items 必须为 evidence_item@1 对象")
        _canonical_artifact("evidence_item", ei)
        if ei.get("match_grade") == "exact":
            lit_items.append(ei)

    # ── 逐候选评估 ──
    mandatory_ids = [r["rule_id"] for r in ruleset["rules"]
                     if r.get("mandatory") and r["rule_id"] not in exclude_set]
    mandatory_coverage = {rid: 0 for rid in mandatory_ids}
    counters = {"searched_space": len(windows), "excluded": 0, "unknown": 0}

    def feature_intervals(feature):
        L = len(contig_seqs[feature["contig"]])
        topo = topology_by_name.get(feature["contig"], "linear")
        return unwrap_intervals(L, topo, feature["segments"])

    candidates_out = []
    for wi, (contig, segs, _key) in enumerate(windows):
        L = len(contig_seqs[contig])
        topo = topology_by_name.get(contig, "linear")
        domain_hi = 2 * L if topo == "circular" else L
        window_iv = unwrap_intervals(L, topo, segs)
        window_len = sum(e - s for s, e in segs)
        loc_features = [f for f in features if f["contig"] == contig]
        region_annotated = False
        for f in loc_features:
            if overlap_nt(window_iv, feature_intervals(f)) > 0:
                region_annotated = True
                break
        window_seq = _locus_sequence(L, topo, segs, contig_seqs[contig])

        verdicts = {}   # rule_id → (code, detail?)
        for rid in mandatory_ids:
            r = rules_by_id[rid]
            p = params_of(rid)
            if rid == "feature_overlap":
                w = int(p.get("window", 200))
                classes = p.get("feature_classes") or []
                iv = expand_intervals(window_iv, w, domain_hi)
                hit = [f for f in loc_features if f["type"] in classes and overlap_nt(iv, feature_intervals(f)) > 0]
                if hit:
                    verdicts[rid] = ("EXCLUDE", "class feature overlap: %s" % hit[0]["feature_id"])
                elif not region_annotated:
                    verdicts[rid] = ("UNKNOWN", "locus 无注释（unknown_policy=block）")
                else:
                    verdicts[rid] = ("PASS", None)
            elif rid == "repeat":
                w = int(p.get("window_bp", 200))
                min_len = int(p.get("min_repeat_length_bp", 20))
                classes = p.get("annotated_repeat_classes") or []
                iv = expand_intervals(window_iv, w, domain_hi)
                ann_hit = [f for f in loc_features if f["type"] in classes and overlap_nt(iv, feature_intervals(f)) > 0]
                # ab-initio：取展开窗口序列（环绕）
                expanded_segs = []
                for s, e in segs:
                    expanded_segs.append([max(0, s - w), min(L, e + w)])
                expanded_seq = _locus_sequence(L, topo, expanded_segs, contig_seqs[contig])
                dup = find_repeat_unit(expanded_seq, min_len)
                if ann_hit:
                    verdicts[rid] = ("EXCLUDE", "annotated repeat feature: %s" % ann_hit[0]["feature_id"])
                elif dup is not None:
                    verdicts[rid] = ("EXCLUDE", "ab-initio repeat unit_len=%d" % dup[0])
                else:
                    verdicts[rid] = ("PASS", None)
            elif rid == "essentiality":
                prox = int(p.get("proximity_window_bp", 200))
                iv = expand_intervals(window_iv, prox, domain_hi)
                if essential_ids is None:
                    verdicts[rid] = ("UNKNOWN", "essentiality 证据缺失（unknown_policy=block）")
                else:
                    hit = [f for f in loc_features if f["feature_id"] in essential_ids
                           and overlap_nt(iv, feature_intervals(f)) > 0]
                    if hit:
                        verdicts[rid] = ("EXCLUDE", "essential gene in proximity: %s" % hit[0]["feature_id"])
                    else:
                        verdicts[rid] = ("PASS", None)
            elif rid == "neighborhood":
                origin_w = int(p.get("origin_exclusion_window_bp", 2000))
                origin = origin_positions.get(contig)
                if topo == "circular" and origin is None:
                    origin = 0
                if origin is None:
                    verdicts[rid] = ("UNKNOWN", "线性 contig 未声明 origin（unknown_policy=block）")
                else:
                    d = _circular_distance_to_point(topo, L, segs, origin)
                    if d is not None and d <= origin_w:
                        verdicts[rid] = ("EXCLUDE", "距复制起点 %d bp <= %d" % (d, origin_w))
                    elif high_exp_ids is None:
                        verdicts[rid] = ("UNKNOWN", "expression 证据缺失（expression_evidence_required）")
                    else:
                        prox = 200
                        iv = expand_intervals(window_iv, prox, domain_hi)
                        hit = [f for f in loc_features if f["feature_id"] in high_exp_ids
                               and overlap_nt(iv, feature_intervals(f)) > 0]
                        if hit:
                            verdicts[rid] = ("EXCLUDE", "高表达基因邻域: %s" % hit[0]["feature_id"])
                        else:
                            verdicts[rid] = ("PASS", None)
            elif rid == "motif":
                w = int(p.get("window_bp", 200))
                classes = p.get("annotated_regulatory_classes") or []
                table = p.get("sequence_motif_table") or []
                iv = expand_intervals(window_iv, w, domain_hi)
                ann_hit = [f for f in loc_features if f["type"] in classes and overlap_nt(iv, feature_intervals(f)) > 0]
                expanded_segs = []
                for s, e in segs:
                    expanded_segs.append([max(0, s - w), min(L, e + w)])
                expanded_seq = _locus_sequence(L, topo, expanded_segs, contig_seqs[contig])
                motif_hit = None
                for entry in table:
                    if not isinstance(entry, dict) or not isinstance(entry.get("sequence"), str) or not entry["sequence"]:
                        continue
                    if entry["sequence"] in expanded_seq:
                        motif_hit = entry
                        break
                    if not entry.get("strand_sensitive") and revcomp(entry["sequence"]) in expanded_seq:
                        motif_hit = entry
                        break
                if ann_hit:
                    verdicts[rid] = ("EXCLUDE", "调控元件: %s" % ann_hit[0]["feature_id"])
                elif motif_hit is not None:
                    verdicts[rid] = ("EXCLUDE", "序列 motif: %s" % motif_hit.get("id") or motif_hit.get("sequence"))
                elif not region_annotated:
                    verdicts[rid] = ("UNKNOWN", "locus 无注释（调控元件无法核实）")
                else:
                    verdicts[rid] = ("PASS", None)
            else:
                verdicts[rid] = ("UNKNOWN", "未知规则类型（unknown_policy=block）")
            if verdicts[rid][0] in ("PASS", "EXCLUDE"):
                mandatory_coverage[rid] += 1

        # ── 分类装配 ──
        exclude_rids = [rid for rid, (code, _d) in verdicts.items() if code == "EXCLUDE"]
        unknown_rids = [rid for rid, (code, _d) in verdicts.items() if code == "UNKNOWN"]
        if exclude_rids:
            classification = "excluded"
            counters["excluded"] += 1
        elif unknown_rids:
            classification = "blocked"
            counters["unknown"] += 1
        elif cassette["sequence_identity"] == "known":
            classification = "screened_candidate"
            if lit_items:
                for ei in lit_items:
                    ps = ei.get("part_sequence") or {}
                    ps_seq = ps.get("sequence") if isinstance(ps, dict) else None
                    ps_sha = ps.get("sha256") if isinstance(ps, dict) else None
                    if (ps_sha and ps_sha == hashlib.sha256(window_seq.encode("utf-8")).hexdigest()) or (ps_seq and ps_seq == window_seq):
                        classification = "literature_characterized"
                        break
        else:
            classification = "preliminary_candidate"

        # ── reasons（ruleset 顺序；advisory 只标记）──
        reasons = []
        for rid in rule_order:
            code, detail = verdicts.get(rid, ("SKIP", None))
            if rid not in verdicts:
                continue
            entry = {"rule_id": rid, "code": code}
            if detail:
                entry["detail"] = detail
            reasons.append(entry)
        for r in ruleset["rules"]:
            if r["rule_id"] in exclude_set:
                reasons.append({"rule_id": r["rule_id"], "code": "SKIP", "detail": "excluded by user"})
        advisory = [r for r in ruleset["rules"] if not r.get("mandatory")]
        for r in advisory:
            p = params_of(r["rule_id"])
            fw = int(p.get("flag_window_bp", 2000))
            classes = p.get("flag_features") or []
            iv = expand_intervals(window_iv, fw, domain_hi)
            hit = [f for f in loc_features if f["type"] in classes and overlap_nt(iv, feature_intervals(f)) > 0]
            if hit:
                reasons.append({"rule_id": r["rule_id"], "code": "FLAG_FOR_REVIEW",
                               "detail": "%s 邻近 flag 特征: %s" % (r["rule_id"], hit[0]["feature_id"])})

        # ── features_hit（窗口原始交集；oracle 语义）──
        features_hit = []
        for f in loc_features:
            ov = overlap_nt(window_iv, feature_intervals(f))
            if ov > 0:
                features_hit.append({"feature_id": f["feature_id"], "overlap_nt": ov,
                                     "strand": f["strand"], "type": f["type"]})
        features_hit.sort(key=lambda x: (x["feature_id"], x["type"]))
        features_hit_ids = [x["feature_id"] for x in features_hit]

        # ── flank（M2/M3 语义；环形环绕；窗口末段终点为窗口 end）──
        last_seg_end = segs[-1][1]
        flank_left = {"start": (segs[0][0] - FLANK_BP) % L, "end": segs[0][0] % L}
        flank_right = {"start": last_seg_end % L, "end": (last_seg_end + FLANK_BP) % L}
        fseq_l = take_circle(contig_seqs[contig], segs[0][0] - FLANK_BP, FLANK_BP)
        fseq_r = take_circle(contig_seqs[contig], last_seg_end, FLANK_BP)

        candidate = {
            "artifact_type": "integration_candidate@1",
            "genome_ref": _artifact_ref(host_profile["genome_ref"]["artifact_id"], "genome_ref.json"),
            "ruleset_ref": _artifact_ref(ruleset_sha, "integration_ruleset-v0.json"),
            "contig": contig,
            "interval": {"start": segs[0][0], "end": last_seg_end, "convention": "0-based-half-open"},
            "strand": "plus",
            "cassette": {
                "sequence_identity": cassette["sequence_identity"],
                **( {"sequence_sha256": cassette["sequence_sha256"]} if cassette["sequence_sha256"] else {}),
                "payload_length": cassette["payload_length"],
            },
            "classification": classification,
            "screening_stage": ("sequence_verified" if classification in ("screened_candidate", "literature_characterized")
                                else ("preliminary_spatial" if classification == "preliminary_candidate" else "preliminary_spatial")),
            "reasons": reasons,
            "counts": {
                "searched_space": len(windows),
                "excluded": counters["excluded"],
                "unknown": counters["unknown"],
                "mandatory_rule_coverage": [{"rule_id": rid, "covered": mandatory_coverage[rid]} for rid in mandatory_ids],
            },
            "features_hit": features_hit_ids,
            "flanking": {"left": flank_left, "right": flank_right},
            "origin_crossing": topo == "circular" and len(segs) == 2 and segs[0][1] == L and segs[1][0] == 0,
            "normalized_flank_hashes": {
                "left": hashlib.sha256(fseq_l.encode("utf-8")).hexdigest(),
                "right": hashlib.sha256(fseq_r.encode("utf-8")).hexdigest(),
            },
        }
        candidates_out.append(candidate)
    candidates_out = candidates_out[:top_n]

    # ── 输出（≤top_n；每个候选一个 artifact）──
    staging = _staging_dir()
    artifacts = []
    for i, cand in enumerate(candidates_out, 1):
        logical = "integration_candidate-%02d.json" % i
        emitted = _emit_candidates(staging, [{"logical_name": logical, "stem": "integration_candidate", "value": cand}])
        artifacts.extend(emitted)
    refs = [_artifact_ref(a["sha256"], a["logical_name"]) for a in artifacts]
    envelope = _envelope(
        "OK", "OK",
        "integration candidates: %d windows, excluded=%d unknown=%d output=%d (ruleset=%s)"
        % (len(windows), counters["excluded"], counters["unknown"], len(candidates_out), ruleset.get("ruleset_id")),
        refs,
    )
    return _result(envelope, artifacts)


# ───────────────────────── 6.3 design_circuit_contextualize ─────────────────────────

_EVIDENCE_LEVEL_ORDER = {"E0": 0, "E1": 1, "E2": 2, "E3": 3}


def _evidence_items_from_arg(args):
    """parts_evidence：嵌入列表或文件（{path, sha256}）二选一。返回 {part_id: item}（保持输入序）。"""
    pe = args.get("parts_evidence")
    if pe is None:
        return []
    if isinstance(pe, list):
        items = pe
    elif isinstance(pe, dict) and pe.get("path"):
        _verify_input_files([pe], "parts evidence")
        try:
            with open(pe["path"], encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError) as exc:
            raise ToolError("INVALID_INPUT", "parts_evidence 不可解析: %s" % str(exc)[:200])
        items = doc.get("items") if isinstance(doc, dict) and isinstance(doc.get("items"), list) else None
        if items is None:
            raise ToolError("INVALID_INPUT", "parts_evidence 文件需含 items[]")
    else:
        raise ToolError("INVALID_INPUT", "parts_evidence 必须为列表或 {path, sha256}")
    out = []
    for it in items:
        if not (isinstance(it, dict) and isinstance(it.get("part_id"), str) and it.get("part_id")
                and isinstance(it.get("evidence_level"), str) and it["evidence_level"] in _EVIDENCE_LEVEL_ORDER):
            raise ToolError("INVALID_INPUT", "parts_evidence 项需 {part_id, evidence_level}（E0–E3）")
        out.append(it)
    return out


def _circuit_design_value(args):
    """components[] / sbol_file → 最小 circuit_design@1（template 记录；SBOL 仅取组件 id）。"""
    circuit = args.get("circuit")
    if not isinstance(circuit, dict):
        raise ToolError("INVALID_INPUT", "circuit 必填")
    components = circuit.get("components")
    if not isinstance(components, list) or not components:
        raise ToolError("INVALID_INPUT", "circuit.components[] 必填（B1P1 不接受空电路）")
    template = circuit.get("template")
    if template is None:
        template = {"template_id": "expression_balance", "version": "0"}
    if not (isinstance(template, dict) and isinstance(template.get("template_id"), str)
            and template.get("template_id") in ("expression_balance", "metabolic_valve")
            and isinstance(template.get("version"), str)):
        raise ToolError("INVALID_INPUT", "circuit.template 需 {template_id, version}（expression_balance|metabolic_valve）")
    comps = []
    for i, c in enumerate(components):
        if not (isinstance(c, dict) and isinstance(c.get("component_id"), str) and c["component_id"]):
            raise ToolError("INVALID_INPUT", "circuit.components[%d] 需 component_id" % i)
        kind = c.get("kind")
        if kind is None:
            kind = "other"
        if kind not in ("promoter", "rbs", "cds", "terminator", "spacer", "other"):
            raise ToolError("INVALID_INPUT", "circuit.components[%d] kind 非法" % i)
        entry = {"part_id": c["component_id"], "kind": kind}
        if isinstance(c.get("sequence"), str) and c["sequence"]:
            entry["sequence"] = c["sequence"]
        comps.append(entry)
    return {
        "artifact_type": "circuit_design@1",
        "source": "components",
        "components": comps,
        "orientation": "unspecified",
        "template_ref": {"template_id": template["template_id"], "version": template["version"]},
        "conformance": {"status": "not_run"},
    }


def _ostir_proxy(ostir_request):
    """可选 ostir_proxy：preflight（import ostir + RNA）失败 → DEPENDENCY_UNAVAILABLE（不静默降级）。

    本环境 ostir 未安装 → 恒走 DEPENDENCY_UNAVAILABLE（负例路径）；成功路径防御性实现（不可本地验证）。
    """
    if not isinstance(ostir_request, dict) or not isinstance(ostir_request.get("sequence"), str) \
            or not ostir_request["sequence"]:
        raise ToolError("INVALID_INPUT", "ostir_request 需 {sequence}")
    try:
        import RNA  # noqa: F401
        import ostir  # noqa: F401
    except ImportError as exc:
        raise ToolError("DEPENDENCY_UNAVAILABLE", "OSTIR_UNAVAILABLE: %s" % str(exc)[:120])
    try:
        from ostir import run_ostir  # noqa: F401
        result = run_ostir(ostir_request["sequence"])
    except Exception as exc:  # noqa: BLE001
        raise ToolError("DEPENDENCY_UNAVAILABLE", "OSTIR_RUN_FAILED: %s" % str(exc)[:120])
    if not isinstance(result, dict):
        raise ToolError("DEPENDENCY_UNAVAILABLE", "OSTIR_RUN_FAILED: 非对象返回")
    return result


def op_design_circuit_contextualize(args):
    """bio_circuit_contextualize：circuit + host_profile → expression_scenario@1（+ kinetic_crn_ref@1）。

    门禁：无证据/无模型 → 只给 rank + risk，禁止绝对表达（value 一律禁出）；coupling_mode 仅产
    耦合草案（不可定量授权）；ostir 走可选依赖 + preflight（不可用 → DEPENDENCY_UNAVAILABLE）。
    """
    host_profile, _hp_sha, _gr_value = _load_host_profile(args)
    coupling_mode = args.get("coupling_mode")
    if coupling_mode is None:
        coupling_mode = "qualitative_direction"
    if coupling_mode not in ("qualitative_direction", "user_calibrated_bound", "evidence_calibrated_bound"):
        raise ToolError("INVALID_INPUT", "coupling_mode 非法（qualitative_direction|user_calibrated_bound|evidence_calibrated_bound）")

    circuit_value = _circuit_design_value(args)
    circuit_sha = _canonical_artifact("circuit_design", circuit_value)[1]
    components = circuit_value["components"]
    n = len(components)

    # ── 可选 ostir proxy（preflight）──
    ostir_result = None
    if args.get("ostir_request") is not None:
        ostir_result = _ostir_proxy(args.get("ostir_request"))

    # ── 证据查表 → rank（E3>E2>E1>E0；同档 rank_hint 降序；unknown 按输入序排后）──
    evidence = _evidence_items_from_arg(args)
    by_part = {}
    for it in evidence:
        by_part.setdefault(it["part_id"], []).append(it)
    results = []
    for i, comp in enumerate(components, 1):
        part = comp["part_id"]
        items = by_part.get(part, [])
        if items:
            ordered = sorted(items, key=lambda x: (-_EVIDENCE_LEVEL_ORDER[x["evidence_level"]],
                                                   -(x.get("rank_hint") or 0), x.get("source_id") or ""))
            top = ordered[0]
            results.append({"element": part, "rank": None, "evidence_level": top["evidence_level"]})
        else:
            results.append({"element": part, "rank": None})
    # 排序：known（E 降序）在前，unknown 按组件序在后；rank 1..N 全局唯一
    known = [r for r in results if r.get("evidence_level") is not None]
    unknown = [r for r in results if r.get("evidence_level") is None]
    known_sorted = sorted(known, key=lambda r: (-_EVIDENCE_LEVEL_ORDER[r["evidence_level"]], r["element"]))
    unknown_sorted = sorted(unknown, key=lambda r: r["element"])
    ranked = known_sorted + unknown_sorted
    for pos, r in enumerate(ranked, 1):
        r["rank"] = pos

    results_out = []
    for r in ranked:
        entry = {
            "element": r["element"],
            "metric": "evidence_rank",
            "value_or_rank": {"kind": "rank", "rank": r["rank"]},
            "conditions": "coupling_mode=%s" % coupling_mode,
        }
        if r.get("evidence_level") is not None:
            entry["evidence_level"] = r["evidence_level"]
        results_out.append(entry)

    # ── host_profile / circuit_design refs ──
    host_ref = _artifact_ref(_hp_sha, "host_profile.json")
    circuit_ref = _artifact_ref(circuit_sha, "circuit_design.json")

    # ── 可选 kinetic_crn_ref@1（引用现有 bio_circuit_compile 输出；封装为 artifact）──
    kinetic_crn = None
    crn_ref = args.get("crn_sbml_ref")
    if crn_ref is not None:
        if not (isinstance(crn_ref, dict) and isinstance(crn_ref.get("artifact_id"), str)
                and isinstance(crn_ref.get("expected_sha256"), str) and isinstance(crn_ref.get("relative_path"), str)):
            raise ToolError("INVALID_INPUT", "crn_sbml_ref 需 {artifact_id, expected_sha256, relative_path}")
        kinetic_crn = {
            "artifact_type": "kinetic_crn_ref@1",
            "model_kind": "kinetic_crn",
            "sbml_ref": {
                "artifact_id": crn_ref["artifact_id"],
                "expected_sha256": crn_ref["expected_sha256"],
                "relative_path": crn_ref["relative_path"],
            },
            "compiled_from": {"source": "bio_circuit_compile", "tool": "dsh-bio-genie"},
        }

    # ── scenario（禁绝对表达：无 value；仅 rank + risk）──
    assumptions = ["coupling_mode=%s 仅耦合草案（不可定量授权）" % coupling_mode]
    if ostir_result is not None:
        assumptions.append("ostir_proxy applied (sequence_length=%d)" % len(args["ostir_request"]["sequence"]))
    else:
        assumptions.append("ostir_proxy 未请求；CRN 层引用 bio_circuit_compile 输出（kinetic_crn_ref@1）")
    scenario = {
        "artifact_type": "expression_scenario@1",
        "circuit_design": circuit_ref,
        "host_profile": host_ref,
        "method": "ostir_proxy" if ostir_result is not None else "evidence_lookup",
        "results": results_out,
        "domain_check": "in_domain",
        "ranking_set_id": "rank-%s-%d-components" % (coupling_mode, n),
        "comparison_scope": "intra-circuit",
        "metric_definition": "evidence_rank: E3>E2>E1>E0, tiebreak rank_hint desc then source_id; unknown after known",
        "higher_is": "high",
        "assumptions": assumptions,
        "rank_algorithm": {"id": "evidence_lookup_v1", "version": "0",
                           "params": {"tie_break": "rank_hint_desc_then_source_id", "unknown_after_known": True}},
        "tie_null_policy": "deterministic_order",
        "uncertainty": "quantitative_authorized=false; coupling 仅草案；无证据元件只给 rank",
    }
    if kinetic_crn is not None:
        kc_sha = _canonical_artifact("kinetic_crn_ref", kinetic_crn)[1]
        scenario["model_or_dataset_ref"] = _artifact_ref(kc_sha, "kinetic_crn_ref.json")
        scenario["assumptions"].append("kinetic_crn_ref@1 封装 bio_circuit_compile 输出")

    # ── 输出 ──
    staging = _staging_dir()
    artifacts = _emit_candidates(staging, [
        {"logical_name": "circuit_design.json", "stem": "circuit_design", "value": circuit_value},
        {"logical_name": "expression_scenario.json", "stem": "expression_scenario", "value": scenario},
    ])
    if kinetic_crn is not None:
        artifacts.extend(_emit_candidates(staging, [
            {"logical_name": "kinetic_crn_ref.json", "stem": "kinetic_crn_ref", "value": kinetic_crn},
        ]))
    refs = [_artifact_ref(a["sha256"], a["logical_name"]) for a in artifacts]
    envelope = _envelope(
        "OK", "OK",
        "expression scenario: %d components ranked (method=%s, coupling=%s, crn=%s)"
        % (n, scenario["method"], coupling_mode, "yes" if kinetic_crn is not None else "no"),
        refs,
    )
    return _result(envelope, artifacts)


# ───────────────────────── OPS 表 + dispatcher ─────────────────────────

OPS = {
    "design_chassis_profile": op_design_chassis_profile,
    "design_integration_candidates": op_design_integration_candidates,
    "design_circuit_contextualize": op_design_circuit_contextualize,
}

TOOL_OP_NAMES = {
    "bio_chassis_profile": "design_chassis_profile",
    "bio_integration_candidates": "design_integration_candidates",
    "bio_circuit_contextualize": "design_circuit_contextualize",
}


def main():
    stdin = sys.stdin.read()
    try:
        req = json.loads(stdin) if stdin.strip() else None
    except ValueError:
        req = None
    if not isinstance(req, dict) or not isinstance(req.get("op"), str):
        print(json.dumps({"ok": False, "code": "BAD_REQUEST", "detail": "stdin 需 {\"op\": ..., \"args\": ...}"}))
        return 0
    op = req.get("op")
    args = req.get("args")
    if args is None:
        args = {}
    if not isinstance(args, dict):
        print(json.dumps({"ok": False, "code": "BAD_REQUEST", "detail": "args 必须为对象"}))
        return 0
    if op not in OPS:
        print(json.dumps({"ok": False, "code": "UNKNOWN_OP", "detail": "unknown op: %s" % op}))
        return 0
    try:
        result = OPS[op](args)
        print(json.dumps(result))
    except ToolError as exc:
        # 信封语义：status 来自状态词；reason_code 取 detail 前缀（"REASON: msg" 约定）；
        # 无前缀时 reason_code 回落到 status（INVALID_INPUT 等无独立 reason 的状态）。
        status = exc.code if exc.code in TOOL_STATES else "EXECUTION_ERROR"
        detail = exc.detail or ""
        reason = status
        if detail:
            head, sep, tail = detail.partition(":")
            head = head.strip()
            if sep and head and all(ch.isupper() or ch == "_" for ch in head):
                reason = head
                detail = tail.strip()
        envelope = _envelope(status, reason, detail)
        print(json.dumps(_result(envelope, [])))
    except Exception as exc:  # noqa: BLE001
        trace = traceback.format_exc(limit=5)
        envelope = _envelope("EXECUTION_ERROR", "WORKER_CRASH", trace[-800:])
        print(json.dumps(_result(envelope, [])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
