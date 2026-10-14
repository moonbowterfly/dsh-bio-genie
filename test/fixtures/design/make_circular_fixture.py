#!/usr/bin/env python
"""Circular genome fixture generator — for coordinate-semantics oracles (M2/M3/M13).

Deterministic: fixed seed; re-running produces byte-identical outputs.
Usage:
  python make_circular_fixture.py           # generate all fixture files
  python make_circular_fixture.py --verify  # re-derive from frozen files and compare

Outputs (same directory):
  fixture_circular.fna          single record synth_circ_4200 (4200 nt, circular)
  fixture_features.tsv          feature table (0-based half-open, segments for origin-crossers)
  fixture_candidates.tsv        candidate insertion windows (payload=40 nt)
  fixture_expected_vectors.json expected results under draft ruleset R0
  SHA256SUMS-fixture.txt        hashes of the above
"""
import hashlib
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
L = 4200
SEED = 20261012
RECORD_NAME = "synth_circ_4200"
RULESET = "R0-draft"

# ---- layout (0-based, half-open) ----
# oriCDS crosses origin: segments [3950,4200) + [0,100)
FEATURES = [
    # id, type, strand, segments (list of [s,e)), note
    ("oriCDS", "CDS", "-", [[3950, 4200], [0, 100]], "crosses_origin; minus-strand synthetic ORF"),
    ("geneA", "CDS", "+", [[200, 1100]], "essential_candidate=true; synthetic ORF"),
    ("geneB", "CDS", "-", [[1200, 1800]], "minus-strand synthetic ORF"),
    ("rrnX", "rRNA", "+", [[1950, 2450]], "synthetic rRNA-like"),
    ("trnX", "tRNA", "-", [[2600, 2676]], "synthetic tRNA-like (76 nt)"),
    ("rep1", "repeat", "+", [[2900, 2980]], "direct_repeat_copy_1 (R)"),
    ("rep2", "repeat", "+", [[3050, 3130]], "direct_repeat_copy_2 (R, identical to rep1)"),
    ("geneC", "CDS", "+", [[3300, 3900]], "synthetic ORF"),
]

CANDIDATES = [
    # id, segments, note
    ("C01", [[250, 290]], "inside_geneA"),
    ("C02", [[1150, 1190]], "clean_intergenic"),
    ("C03", [[2650, 2690]], "partial_tRNA_overlap_26nt"),
    ("C04", [[2940, 2980]], "inside_rep1"),
    ("C05", [[2960, 3010]], "partial_rep1_overlap_20nt"),
    ("C06", [[4160, 4200], [0, 30]], "crosses_origin_window; overlaps_oriCDS_both_segments"),
    ("C07", [[4100, 4140]], "inside_oriCDS_seg1"),
    ("C08", [[50, 90]], "inside_oriCDS_seg2"),
    ("C09", [[2050, 2090]], "inside_rrnX"),
    ("C10", [[3600, 3640]], "inside_geneC"),
    ("C11", [[1900, 1940]], "clean_intergenic"),
    ("C12", [[3030, 3070]], "partial_rep2_overlap_20nt"),
    ("C13", [[100, 140]], "clean_intergenic_near_origin"),
    ("C14", [[3080, 3120]], "inside_rep2"),
    ("C15", [[90, 130]], "tiny_oriCDS_overlap_10nt"),
]

RULE_LIST = [
    {"id": "R0-1", "desc": "overlap CDS -> excluded"},
    {"id": "R0-2a", "desc": "overlap rRNA -> excluded"},
    {"id": "R0-2b", "desc": "overlap tRNA -> excluded"},
    {"id": "R0-3", "desc": "overlap repeat -> excluded"},
    {"id": "R0-4", "desc": "no overlap with CDS/rRNA/tRNA/repeat -> screened_candidate"},
]


def _rand_seq(rng, n):
    return "".join(rng.choice("ACGT") for _ in range(n))


def _revcomp(s):
    return s.translate(str.maketrans("ACGT", "TGCA"))[::-1]


def build_sequence():
    rng = random.Random(SEED)
    seq = list(_rand_seq(rng, L))

    def place(s, start):
        for i, ch in enumerate(s):
            seq[(start + i) % L] = ch

    geneA = "ATG" + _rand_seq(rng, 894) + "TAA"          # 900
    place(geneA, 200)
    geneB_plus = _revcomp("ATG" + _rand_seq(rng, 594) + "TAA")  # 600, minus-strand ORF
    place(geneB_plus, 1200)
    place(_rand_seq(rng, 500), 1950)                      # rrnX
    place(_revcomp(_rand_seq(rng, 76)), 2600)             # trnX (minus strand)
    rep = _rand_seq(rng, 80)
    place(rep, 2900)                                      # rep1
    place(rep, 3050)                                      # rep2 (identical)
    geneC = "ATG" + _rand_seq(rng, 594) + "TAA"           # 600
    place(geneC, 3300)
    ori_plus = _revcomp("ATG" + _rand_seq(rng, 344) + "TAA")  # 350, minus strand
    place(ori_plus[:250], 3950)
    place(ori_plus[250:], 0)
    return "".join(seq)


def take_circle(seq, start, length):
    """Extract `length` chars starting at `start` (may wrap)."""
    start %= L
    out = seq[start:start + length]
    if len(out) < length:
        out += seq[:length - len(out)]
    return out


def norm_segments(segs):
    out = []
    for s, e in segs:
        assert 0 <= s < e <= L, "segment must satisfy 0<=s<e<=L: %r" % ((s, e),)
        out.append([int(s), int(e)])
    return out


def overlap_nt(segs_a, segs_b):
    """Total overlap length between two sets of 0-based half-open segments (non-wrapping each)."""
    total = 0
    for a_s, a_e in segs_a:
        for b_s, b_e in segs_b:
            lo, hi = max(a_s, b_s), min(a_e, b_e)
            if hi > lo:
                total += hi - lo
    return total


def classify(hits):
    """Draft ruleset R0 over hits [(feature_id, type, strand, overlap_nt)]."""
    for fid, ftype, _strand, ov in hits:
        if ov <= 0:
            continue
        if ftype == "CDS":
            return "excluded", "R0-1"
        if ftype == "rRNA":
            return "excluded", "R0-2a"
        if ftype == "tRNA":
            return "excluded", "R0-2b"
        if ftype == "repeat":
            return "excluded", "R0-3"
    return "screened_candidate", "R0-4"


def compute_vectors(seq):
    vecs = []
    for cid, csegs, note in CANDIDATES:
        csegs = norm_segments(csegs)
        hits = []
        for fid, ftype, strand, fsegs, _note in _features_norm():
            ov = overlap_nt(csegs, fsegs)
            if ov > 0:
                hits.append({"feature_id": fid, "type": ftype, "strand": strand, "overlap_nt": ov})
        start = csegs[0][0]
        end = csegs[-1][1]
        left = take_circle(seq, start - 60, 60)
        right = take_circle(seq, end, 60)
        classification, rule_id = classify([(h["feature_id"], h["type"], h["strand"], h["overlap_nt"]) for h in hits])
        vecs.append({
            "candidate_id": cid,
            "segments": csegs,
            "note": note,
            "features_hit": hits,
            "flank_left_60": {"seq": left, "sha256": hashlib.sha256(left.encode()).hexdigest()},
            "flank_right_60": {"seq": right, "sha256": hashlib.sha256(right.encode()).hexdigest()},
            "classification": classification,
            "rule_id": rule_id,
        })
    return vecs


def _features_norm():
    out = []
    for fid, ftype, strand, segs, note in FEATURES:
        out.append((fid, ftype, strand, norm_segments(segs), note))
    return out


def write_all():
    seq = build_sequence()
    fna = ">%s synthetic circular genome fixture (L=%d) ruleset=%s\n" % (RECORD_NAME, L, RULESET)
    for i in range(0, L, 70):
        fna += seq[i:i + 70] + "\n"
    with open(os.path.join(HERE, "fixture_circular.fna"), "w", encoding="utf-8", newline="\n") as f:
        f.write(fna)

    with open(os.path.join(HERE, "fixture_features.tsv"), "w", encoding="utf-8", newline="\n") as f:
        f.write("feature_id\ttype\tstrand\tsegments\tlength\tnote\n")
        for fid, ftype, strand, segs, note in FEATURES:
            segs_s = ";".join("%d-%d" % (s, e) for s, e in segs)
            length = sum(e - s for s, e in segs)
            f.write("%s\t%s\t%s\t%s\t%d\t%s\n" % (fid, ftype, strand, segs_s, length, note))

    with open(os.path.join(HERE, "fixture_candidates.tsv"), "w", encoding="utf-8", newline="\n") as f:
        f.write("candidate_id\tsegments\tpayload_length\tnote\n")
        for cid, csegs, note in CANDIDATES:
            segs_s = ";".join("%d-%d" % (s, e) for s, e in norm_segments(csegs))
            payload = sum(e - s for s, e in norm_segments(csegs))
            f.write("%s\t%s\t%d\t%s\n" % (cid, segs_s, payload, note))

    vecs = compute_vectors(seq)
    doc = {
        "fixture": "synth_circ_4200",
        "length": L,
        "topology": "circular",
        "coord_convention": "0-based-half-open",
        "ruleset": RULESET,
        "rules": RULE_LIST,
        "generator": "make_circular_fixture.py",
        "seed": SEED,
        "fasta_sha256": hashlib.sha256(fna.encode()).hexdigest(),
        "candidates": vecs,
    }
    with open(os.path.join(HERE, "fixture_expected_vectors.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    names = ["fixture_circular.fna", "fixture_features.tsv", "fixture_candidates.tsv", "fixture_expected_vectors.json"]
    with open(os.path.join(HERE, "SHA256SUMS-fixture.txt"), "w", encoding="utf-8", newline="\n") as f:
        for n in names:
            with open(os.path.join(HERE, n), "rb") as g:
                f.write("%s *%s\n" % (hashlib.sha256(g.read()).hexdigest(), n))
    print("WROTE:", ", ".join(names))


def verify():
    with open(os.path.join(HERE, "fixture_circular.fna"), encoding="utf-8") as f:
        lines = [ln.strip() for ln in f if not ln.startswith(">")]
    seq = "".join(lines)
    assert len(seq) == L, "length mismatch: %d" % len(seq)
    with open(os.path.join(HERE, "fixture_expected_vectors.json"), encoding="utf-8") as f:
        frozen = json.load(f)
    recomputed = compute_vectors(seq)
    ok = True
    for a, b in zip(frozen["candidates"], recomputed):
        for k in ("segments", "features_hit", "flank_left_60", "flank_right_60", "classification", "rule_id"):
            if a[k] != b[k]:
                ok = False
                print("MISMATCH", a["candidate_id"], k)
    if frozen["candidates"] != recomputed:
        ok = False
    print("VERIFY:", "OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    if "--verify" in sys.argv:
        sys.exit(verify())
    write_all()
