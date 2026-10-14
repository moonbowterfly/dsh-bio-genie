#!/usr/bin/env python
"""make_schema_cases.py — build synbio-schema-corpus@1 (dual-side verdict cases).

Cases cover all 23 schemas: minimal valid, missing-required, bad-enum, extra-property,
plus the H2/I1 decimal pathologies, pattern pathologies (trailing-LF), and the
conditional gates (claim classification, coupling manual_override / sequence_proxy).

Zero-backslash source: LF built via chr(10); hashes via repeated hex chars.
"""
import json
import os
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "schema_cases.json")

LF = chr(10)
HEXC = "abcdef0123456789"


def H(n):
    return HEXC[n % 16] * 64


def aref(n):
    return {"artifact_id": H(n), "expected_sha256": H(n), "relative_path": "objects/" + H(n)[:16]}


TS = "2026-10-13T12:00:00Z"
DEC_OK = "12.34"

CASES = []


def add(cid, schema, doc, expect, note=""):
    CASES.append({"id": cid, "schema": schema, "doc": doc, "expect": expect, "note": note})


# ---- genome_ref ----------------------------------------------------------
GR = {
    "artifact_type": "genome_ref@1",
    "files": [{"path": "genome.fna", "sha256": H(1), "format": "fasta"}],
    "contigs": [{"name": "chr1", "length": 4641652, "topology": "circular"}],
    "coord_convention": "0-based-half-open",
    "source": "NCBI RefSeq GCF_000005845.2",
    "fetched_at": TS,
}


def gr():
    return json.loads(json.dumps(GR))


add("gvr-01", "genome_ref", gr(), "valid", "minimal valid")
d = gr(); del d["source"]; add("gvr-02", "genome_ref", d, "invalid", "missing required source")
d = gr(); d["coord_convention"] = "2-based"; add("gvr-03", "genome_ref", d, "invalid", "bad enum")
d = gr(); d["zzz_extra"] = 1; add("gvr-04", "genome_ref", d, "invalid", "additionalProperties false")
d = gr(); d["files"][0]["sha256"] = H(1) + LF; add("gvr-05", "genome_ref", d, "invalid", "sha256 trailing-LF (matcher layer)")
d = gr(); d["fetched_at"] = TS + LF; add("gvr-06", "genome_ref", d, "invalid", "timestamp trailing-LF (matcher layer)")
d = gr(); d["files"][0]["sha256"] = chr(0x1F600) * 64; add("gvr-07", "genome_ref", d, "invalid", "astral non-ASCII sha: DOMAIN-first (cross-side exact code)")
d = gr(); d["files"][0]["sha256"] = chr(0x1F600) * 65; add("gvr-08", "genome_ref", d, "invalid", "astral overlong sha: DOMAIN-first beats MAX_LEN (order oracle)")
d = gr(); d["files"][0]["sha256"] = "b" * 65; add("gvr-09", "genome_ref", d, "invalid", "ascii overlong sha: MAX_LEN")

# ---- input_snapshot ------------------------------------------------------
IS = {
    "artifact_type": "input_snapshot@1",
    "role": "genome_sequence",
    "media_type": "text/x-fasta",
    "format": "fasta",
    "consumer_compatibility": ["bio_chassis_profile"],
    "sha256": H(2),
    "byte_size": 4708035,
    "origin": {"kind": "external", "origin_ref": "upload:genome.fna"},
}


def iss():
    return json.loads(json.dumps(IS))


add("ins-01", "input_snapshot", iss(), "valid", "minimal valid")
d = iss(); del d["sha256"]; add("ins-02", "input_snapshot", d, "invalid", "missing required sha256")
d = iss(); d["role"] = "unknown_role"; add("ins-03", "input_snapshot", d, "invalid", "bad enum role")
d = iss(); d["extra"] = True; add("ins-04", "input_snapshot", d, "invalid", "additionalProperties false")

# ---- host_profile --------------------------------------------------------
HP = {
    "artifact_type": "host_profile@1",
    "genome_ref": aref(3),
    "evidence_state": {
        "annotation": {"completeness": "full"},
        "condition": {"completeness": "partial"},
        "parts_evidence": {"completeness": "missing"},
    },
    "derived": {"genome_size": 4641652, "gc_percent": 50.8, "contig_count": 1},
    "gates": [{"gate": "annotation_parse", "status": "PASS"}],
}


def hp():
    return json.loads(json.dumps(HP))


add("hpf-01", "host_profile", hp(), "valid", "minimal valid")
d = hp(); del d["derived"]; add("hpf-02", "host_profile", d, "invalid", "missing required derived")
d = hp(); d["gates"][0]["status"] = "OK"; add("hpf-03", "host_profile", d, "invalid", "bad gate status enum")
d = hp(); d["tier"] = "reference_profile"; add("hpf-04", "host_profile", d, "invalid", "no product tier field on host_profile")

# ---- condition_card ------------------------------------------------------
CC = {
    "artifact_type": "condition_card@1",
    "medium": {"name": "M9", "carbon_sources": ["glucose"], "oxygen": "aerobic", "temperature_c": 37, "ph": 7.2},
    "culture_mode": "batch",
    "copy_number": {"integration_status": "integrated"},
    "readout": {"kind": "OD600", "unit": "a.u."},
}


def cc():
    return json.loads(json.dumps(CC))


add("ccd-01", "condition_card", cc(), "valid", "minimal valid")
d = cc(); del d["readout"]; add("ccd-02", "condition_card", d, "invalid", "missing required readout")
d = cc(); d["medium"]["oxygen"] = "oxidative"; add("ccd-03", "condition_card", d, "invalid", "bad enum oxygen")
d = cc(); d["ph_note"] = "drift"; add("ccd-04", "condition_card", d, "invalid", "additionalProperties false")

# ---- evidence_item -------------------------------------------------------
EV = {
    "artifact_type": "evidence_item@1",
    "source_ref": {"kind": "pmid", "id": "12345678"},
    "host": {"organism": "Escherichia coli", "strain": "K-12 MG1655"},
    "readout": {"metric": "sfGFP fluorescence", "value": "12.34", "unit": "a.u.", "replicates": 3},
    "match_grade": "exact",
    "matching_policy": {"id": "host-condition-match", "version": "1"},
}


def ev():
    return json.loads(json.dumps(EV))


add("evi-01", "evidence_item", ev(), "valid", "minimal valid (decimal value)")
d = ev(); del d["match_grade"]; add("evi-02", "evidence_item", d, "invalid", "missing required match_grade")
d = ev(); d["readout"]["value"] = "-0"; add("evi-03", "evidence_item", d, "invalid", "decimal -0 rejected")
d = ev(); d["readout"]["value"] = "1e3"; add("evi-04", "evidence_item", d, "invalid", "decimal exponent rejected")
d = ev(); d["readout"]["value"] = "0" + LF; add("evi-05", "evidence_item", d, "invalid", "decimal trailing-LF (scanner+matcher)")
d = ev(); d["readout"]["value"] = "1.00"; add("evi-06", "evidence_item", d, "invalid", "decimal trailing zero rejected")

# ---- circuit_design ------------------------------------------------------
CD = {
    "artifact_type": "circuit_design@1",
    "source": "components",
    "components": [
        {"kind": "promoter", "part_id": "pJ23119"},
        {"kind": "cds", "part_id": "sfGFP"},
    ],
    "template_ref": {"template_id": "expression_balance", "version": "1"},
    "parameters": {"copy": 15},
}


def cd():
    return json.loads(json.dumps(CD))


add("cir-01", "circuit_design", cd(), "valid", "minimal valid")
d = cd(); del d["template_ref"]; add("cir-02", "circuit_design", d, "invalid", "missing required template_ref")
d = cd(); d["template_ref"]["template_id"] = "anything_goes"; add("cir-03", "circuit_design", d, "invalid", "template not in two-template set")
d = cd(); d["components"][0]["kind"] = "enhancer"; add("cir-04", "circuit_design", d, "invalid", "bad component kind enum")

# ---- kinetic_crn_ref -----------------------------------------------------
KC = {"artifact_type": "kinetic_crn_ref@1", "model_kind": "kinetic_crn", "sbml_ref": aref(4)}


def kc():
    return json.loads(json.dumps(KC))


add("kcr-01", "kinetic_crn_ref", kc(), "valid", "minimal valid")
d = kc(); d["model_kind"] = "constraint_gem"; add("kcr-02", "kinetic_crn_ref", d, "invalid", "model_kind const")
d = kc(); del d["sbml_ref"]; add("kcr-03", "kinetic_crn_ref", d, "invalid", "missing required sbml_ref")

# ---- integration_candidate ----------------------------------------------
IC = {
    "artifact_type": "integration_candidate@1",
    "genome_ref": aref(5),
    "ruleset_ref": aref(6),
    "contig": "chr1",
    "interval": {"start": 1000, "end": 2000, "convention": "0-based-half-open"},
    "strand": "plus",
    "cassette": {"payload_length": 1500, "sequence_identity": "unknown"},
    "classification": "preliminary_candidate",
    "screening_stage": "preliminary_spatial",
    "reasons": [{"rule_id": "r1", "detail": "no CDS overlap"}],
    "counts": {"searched_space": 3, "excluded": 1, "unknown": 1, "mandatory_rule_coverage": [{"rule_id": "r1", "covered": 3}]},
}


def ic():
    return json.loads(json.dumps(IC))


add("itc-01", "integration_candidate", ic(), "valid", "minimal valid (length-only cassette)")
d = ic(); d["classification"] = "safe"; add("itc-02", "integration_candidate", d, "invalid", "no safety vocabulary; bad enum")
d = ic(); del d["counts"]; add("itc-03", "integration_candidate", d, "invalid", "missing required counts")
d = ic(); d["interval"]["convention"] = "1-based"; add("itc-04", "integration_candidate", d, "invalid", "convention const")

# ---- expression_scenario -------------------------------------------------
ES = {
    "artifact_type": "expression_scenario@1",
    "circuit_design": aref(7),
    "host_profile": aref(8),
    "method": "ostir_proxy",
    "results": [{"element": "sfGFP", "metric": "translation_init_rate", "value_or_rank": {"kind": "rank", "rank": 1}, "evidence_level": "E1"}],
    "domain_check": "out_of_domain",
    "ranking_set_id": "rank-20261013-1",
    "comparison_scope": "same host, same 5prime context",
    "metric_definition": "ostir proxy rank",
    "higher_is": "high",
}


def es():
    return json.loads(json.dumps(ES))


add("exs-01", "expression_scenario", es(), "valid", "minimal valid (proxy rank)")
d = es(); del d["domain_check"]; add("exs-02", "expression_scenario", d, "invalid", "missing required domain_check")
d = es(); d["results"][0]["value_or_rank"] = {"kind": "median", "value": "1.5"}; add("exs-03", "expression_scenario", d, "invalid", "kind enum value|rank")
d = es(); d["method"] = "absolute_expression"; add("exs-04", "expression_scenario", d, "invalid", "bad method enum")

# ---- gem_card_raw --------------------------------------------------------
GC = {"artifact_type": "gem_card_raw@1", "card_schema": "v2", "raw_sha256": H(9), "raw_bytes_ref": aref(9)}


def gc():
    return json.loads(json.dumps(GC))


add("gcr-01", "gem_card_raw", gc(), "valid", "minimal valid")
d = gc(); d["card_schema"] = "v9"; add("gcr-02", "gem_card_raw", d, "invalid", "bad card_schema enum")
d = gc(); del d["raw_bytes_ref"]; add("gcr-03", "gem_card_raw", d, "invalid", "missing raw_bytes_ref")

# ---- metabolic_model_ref -------------------------------------------------
MM = {
    "artifact_type": "metabolic_model_ref@1",
    "sbml_ref": aref(10),
    "card": {"card_schema": "v2", "card_ref": aref(9)},
    "model_id": "iML1515",
    "genome_link": {"strain": "K-12 MG1655", "genome_sha256": H(1), "match_status": "exact"},
    "gpr": {"coverage_pct": 100.0, "namespace": "b3908", "crosswalk_status": "exact"},
    "objective": "BIOMASS_Ec_iML1515_core_75p37M",
    "baseline": {"feasible": True, "growth": "0.876997", "solver": {"id": "glpk", "version": "5.0"}},
}


def mm():
    return json.loads(json.dumps(MM))


add("mmr-01", "metabolic_model_ref", mm(), "valid", "minimal valid (anchored growth)")
d = mm(); d["baseline"]["growth"] = "0.8769970"; add("mmr-02", "metabolic_model_ref", d, "invalid", "decimal trailing zero")
d = mm(); d["genome_link"]["match_status"] = "fuzzy"; add("mmr-03", "metabolic_model_ref", d, "invalid", "bad match_status enum")
d = mm(); del d["gpr"]; add("mmr-04", "metabolic_model_ref", d, "invalid", "missing required gpr")

# ---- host_model_binding --------------------------------------------------
HB = {
    "artifact_type": "host_model_binding@1",
    "genome_sha256": H(1),
    "model_sbml_sha256": H(10),
    "binding_method": {"id": "faa-gff-coordinate-pair", "version": "1"},
    "evidence_source": "gate5 coordinate pairing",
    "match_result": "exact",
}


def hb():
    return json.loads(json.dumps(HB))


add("hmb-01", "host_model_binding", hb(), "valid", "minimal valid")
d = hb(); d["match_result"] = "probably"; add("hmb-02", "host_model_binding", d, "invalid", "bad match_result enum")
d = hb(); del d["genome_sha256"]; add("hmb-03", "host_model_binding", d, "invalid", "missing genome_sha256")

# ---- gpr_proof -----------------------------------------------------------
GP = {
    "artifact_type": "gpr_proof@1",
    "canonical_gpr_ast": "(OR b3908 b3919)",
    "ast_hash": H(11),
    "source_gene_ids": ["Atu3768"],
    "gem_gene_ids": ["b3908", "b3919"],
    "namespace": "K-12",
    "reaction_id": "R_GLUCOSE",
    "mapping_path": ["Atu3768", "b3908", "R_GLUCOSE"],
}


def gp():
    return json.loads(json.dumps(GP))


add("gpr-01", "gpr_proof", gp(), "valid", "minimal valid")
d = gp(); del d["mapping_path"]; add("gpr-02", "gpr_proof", d, "invalid", "missing mapping_path")
d = gp(); d["ast_hash"] = "not-a-hash"; add("gpr-03", "gpr_proof", d, "invalid", "ast_hash pattern")

# ---- coupling_profile ----------------------------------------------------
def rule(n, mode_input_kind="user_explicit_assumption", dec_val=DEC_OK):
    return {
        "rule_id": "rule-" + str(n),
        "model_ref": aref(10),
        "host_profile": aref(3),
        "host_model_binding_ref": aref(12),
        "gpr_proof_ref": aref(11),
        "condition_card_ref": aref(13),
        "source_gene": {"namespace": "K-12", "id": "b0001"},
        "reaction_id": "R_GLUCOSE",
        "reaction_direction": "forward",
        "operation": "set_upper_bound",
        "baseline_bound": "1000",
        "derived_bound": dec_val,
        "unit": "mmol/gDW/h",
        "mapping_function": {"id": "linear", "version": "1", "parameters": {"scale": 0.5}},
        "condition_hash": H(2),
        "input_kind": mode_input_kind,
        "evidence_refs": [H(1)],
        "assumption_refs": [H(2)],
        "confidence": "medium",
    }


def cpl(mode="user_calibrated_bound", rule_kw=None):
    r = rule(1, **(rule_kw or {}))
    return {"artifact_type": "coupling_profile@1", "mode": mode, "rules": [r]}


add("cpl-01", "coupling_profile", cpl(), "valid", "user_calibrated with full refs")
d = cpl(mode="qualitative_direction", rule_kw={"mode_input_kind": "sequence_proxy"}); add("cpl-02", "coupling_profile", d, "valid", "sequence_proxy in qualitative mode")
d = cpl(mode="evidence_calibrated_bound", rule_kw={"mode_input_kind": "manual_override"}); add("cpl-03", "coupling_profile", d, "invalid", "manual_override not allowed in evidence mode")
d = cpl(mode="user_calibrated_bound", rule_kw={"mode_input_kind": "sequence_proxy"}); add("cpl-04", "coupling_profile", d, "invalid", "sequence_proxy only drives qualitative")
d = cpl(); del d["rules"][0]["gpr_proof_ref"]; add("cpl-05", "coupling_profile", d, "invalid", "missing rule ref")
d = cpl(); d["rules"][0]["derived_bound"] = "0.0"; add("cpl-06", "coupling_profile", d, "invalid", "decimal trailing zero (derived_bound)")
d = cpl(); d["rules"][0]["derived_bound"] = "0" + LF; add("cpl-07", "coupling_profile", d, "invalid", "decimal trailing-LF (derived_bound)")
d = cpl(mode="qualitative_direction", rule_kw={"mode_input_kind": "manual_override"}); add("cpl-08", "coupling_profile", d, "invalid", "manual_override only in user_calibrated_bound")
d = cpl(mode="qualitative_direction", rule_kw={"mode_input_kind": "manual_override"})
d["rules"][0]["assumption_refs"] = []; add("cpl-09", "coupling_profile", d, "invalid", "manual_override empty assumption_refs")
d = cpl(mode="user_calibrated_bound", rule_kw={"mode_input_kind": "manual_override"}); add("cpl-10", "coupling_profile", d, "valid", "manual_override in user_calibrated with non-empty assumption_refs")

# ---- consequence_run -----------------------------------------------------
def scenario():
    return {
        "name": "knockout-glucose",
        "diffs": [{"rule_id": "rule-1", "reaction_id": "R_GLUCOSE", "old_value": "10", "new_value": "0", "unit": "mmol/gDW/h"}],
        "fba": {"status": "optimal", "value": "0.85"},
        "fva": {"intervals": [{"reaction_id": "R_GLUCOSE", "min": "0", "max": "10"}]},
        "pfba": {"status": "optimal", "value": "0.84"},
        "model_hash": H(10),
        "diff_hash": H(14),
        "medium_artifact_id": H(15),
        "applied_rule_ids": ["rule-1"],
        "mapping_proof_ids": [H(11)],
        "target_metric": "EX_ac_e",
    }


def cr():
    return {
        "artifact_type": "consequence_run@1",
        "model_ref": aref(10),
        "coupling_ref": aref(16),
        "numeric_policy_ref": aref(17),
        "medium_ref": aref(15),
        "objective": "BIOMASS_Ec_iML1515_core_75p37M",
        "baseline": {"feasible": True, "status": "optimal", "objective_value": "0.876997", "solver": {"id": "glpk", "version": "5.0"}},
        "scenarios": [scenario()],
        "claim_targets": [{"kind": "growth", "direction": "ROBUST_DIRECTION"}],
    }


add("csq-01", "consequence_run", cr(), "valid", "minimal valid")
d = cr(); d["scenarios"][0]["fba"]["value"] = "-0.5e1"; add("csq-02", "consequence_run", d, "invalid", "decimal exponent form")
d = cr(); d["claim_targets"][0]["direction"] = "UP"; add("csq-03", "consequence_run", d, "invalid", "bad direction enum")
d = cr(); del d["scenarios"][0]["mapping_proof_ids"]; add("csq-04", "consequence_run", d, "invalid", "missing scenario field")
d = cr(); d["scenarios"][0]["fva"]["intervals"][0]["min"] = "1.0"; add("csq-05", "consequence_run", d, "invalid", "decimal trailing zero in FVA")

# ---- tier_decision -------------------------------------------------------
TD = {
    "artifact_type": "tier_decision@1",
    "policy_id": "capability-policy",
    "policy_version": "1",
    "policy_hash": H(18),
    "input_snapshot_id": H(19),
    "per_operation": [{
        "operation": "bio_design_consequence",
        "max_tier": "reference_profile",
        "gates": [{"gate": "exact_binding", "status": "PASS"}],
        "decision": "allow",
        "capabilities": ["quantitative_consequence"],
        "reason_codes": [],
    }],
}


def td():
    return json.loads(json.dumps(TD))


add("tcd-01", "tier_decision", td(), "valid", "minimal valid")
d = td(); d["per_operation"][0]["max_tier"] = "maybe"; add("tcd-02", "tier_decision", d, "invalid", "bad tier enum")
d = td(); del d["policy_hash"]; add("tcd-03", "tier_decision", d, "invalid", "missing policy_hash")

# ---- numeric_policy ------------------------------------------------------
NP = {
    "artifact_type": "numeric_policy@1",
    "fva_fraction_of_optimum": 0.99,
    "solver": {"id": "glpk", "version": "5.0"},
    "tolerance": 0.000001,
    "direction_epsilon": "0.001",
    "near_zero_rule": "abs(value) < epsilon flags near-zero",
    "interval_zero_crossing_rule": "crossing_flags_indeterminate",
}


def np():
    return json.loads(json.dumps(NP))


add("npo-01", "numeric_policy", np(), "valid", "minimal valid")
d = np(); d["direction_epsilon"] = "-0"; add("npo-02", "numeric_policy", d, "invalid", "decimal -0")
d = np(); d["interval_zero_crossing_rule"] = "always_ok"; add("npo-03", "numeric_policy", d, "invalid", "bad crossing rule enum")

# ---- unit_vocabulary -----------------------------------------------------
UV = {
    "artifact_type": "unit_vocabulary@1",
    "units": [{"unit_id": "mmol_per_gdw_per_h", "symbol": "mmol/gDW/h", "dimension": [{"base": "amount", "exponent": 1}, {"base": "mass", "exponent": -1}, {"base": "time", "exponent": -1}]}],
    "conversions": [{"from": "mmol_per_gdw_per_h", "to": "mmol_per_gdw_per_h", "factor": "1"}],
    "forbidden_mixes": [{"a": "a.u.", "b": "mmol_per_gdw_per_h", "reason": "proxy vs capacity"}],
}


def uv():
    return json.loads(json.dumps(UV))


add("unv-01", "unit_vocabulary", uv(), "valid", "minimal valid")
d = uv(); del d["conversions"]; add("unv-02", "unit_vocabulary", d, "invalid", "missing conversions")
d = uv(); d["units"][0]["dimension"][0]["base"] = "currency"; add("unv-03", "unit_vocabulary", d, "invalid", "bad base dimension")

# ---- integration_ruleset -------------------------------------------------
IR = {
    "artifact_type": "integration_ruleset@1",
    "ruleset_id": "default-integration",
    "version": "1",
    "rules": [{"rule_id": "r1", "kind": "feature_overlap", "mandatory": True, "params": {"window": 200}}],
}


def ir():
    return json.loads(json.dumps(IR))


add("irs-01", "integration_ruleset", ir(), "valid", "minimal valid")
d = ir(); del d["version"]; add("irs-02", "integration_ruleset", d, "invalid", "missing version")
d = ir(); d["rules"][0]["kind"] = "vibes"; add("irs-03", "integration_ruleset", d, "invalid", "bad rule kind")

# ---- provenance_dag ------------------------------------------------------
PD = {
    "artifact_type": "provenance_dag@1",
    "nodes": [{"id": H(10), "kind": "artifact", "type": "metabolic_model_ref@1"}, {"id": H(1), "kind": "claim", "type": "claim"}],
    "edges": [{"from": H(10), "to": H(1), "kind": "supports"}],
    "dag_hash": H(20),
}


def pd():
    return json.loads(json.dumps(PD))


add("pvd-01", "provenance_dag", pd(), "valid", "minimal valid")
d = pd(); d["edges"][0]["kind"] = "causes"; add("pvd-02", "provenance_dag", d, "invalid", "bad edge kind")
d = pd(); del d["dag_hash"]; add("pvd-03", "provenance_dag", d, "invalid", "missing dag_hash")

# ---- claim ---------------------------------------------------------------
def cl(**kw):
    base = {"claim_id": H(21), "classification": "FACT", "status": "SUPPORTED"}
    base.update(kw)
    return base


add("clm-01", "claim", cl(evidence_refs=[H(1)]), "valid", "FACT with evidence_refs")
add("clm-02", "claim", cl(classification="ASSUMPTION", status="CONDITIONAL", assumption_refs=[H(2)]), "valid", "ASSUMPTION with assumption_refs")
add("clm-03", "claim", cl(classification="INFERENCE", status="CONDITIONAL", method_ref="fba", domain_ref="iML1515", uncertainty="solver tolerance"), "valid", "INFERENCE with full fields")
add("clm-04", "claim", cl(), "invalid", "FACT without evidence_refs")
d = cl(); d["classification"] = "GUESS"; add("clm-05", "claim", d, "invalid", "bad classification enum")
d = cl(evidence_refs=[H(1)]); d["limitations"] = [""]; add("clm-06", "claim", d, "invalid", "empty limitation string")

# ---- tool_result ---------------------------------------------------------
def tr(**kw):
    base = {"artifact_type": "tool_result@1", "audit_only": True, "status": "OK", "generated_by": "ts_wrapper"}
    base.update(kw)
    return base


add("tsr-01", "tool_result", tr(), "valid", "minimal valid")
add("tsr-02", "tool_result", tr(status="INVALID_INPUT", reason_code="bad_input", generated_by="python_worker"), "valid", "error terminal state")
d = tr(); d["audit_only"] = False; add("tsr-03", "tool_result", d, "invalid", "audit_only const true")
d = tr(); d["status"] = "MAYBE"; add("tsr-04", "tool_result", d, "invalid", "bad status enum")

# ---- case_manifest -------------------------------------------------------
def cm(**kw):
    base = {
        "schema_version": "1.0",
        "case_content_id": H(22),
        "artifacts": [{
            "artifact_id": H(10),
            "type": "metabolic_model_ref@1",
            "inputs": [H(9)],
            "producer": "bio_design_consequence@0.6.x",
            "schema_major": "1",
            "canonical_path": "objects/" + H(10)[:16],
        }],
        "policy": {"policy_id": "capability-policy", "policy_version": "1", "policy_hash": H(18)},
    }
    base.update(kw)
    return base


add("cms-01", "case_manifest", cm(), "valid", "minimal valid")
d = cm(); d["artifacts"][0]["type"] = "mystery@1"; add("cms-02", "case_manifest", d, "invalid", "unknown artifact type")
d = cm(); del d["policy"]; add("cms-03", "case_manifest", d, "invalid", "missing policy")
d = cm(); d["artifacts"][0]["schema_major"] = "2"; add("cms-04", "case_manifest", d, "invalid", "schema_major const")


def main():
    by_schema = {}
    for c in CASES:
        by_schema.setdefault(c["schema"], []).append(c)
    missing = []
    expected_schemas = [
        "genome_ref", "input_snapshot", "host_profile", "condition_card", "evidence_item",
        "circuit_design", "kinetic_crn_ref", "integration_candidate", "expression_scenario",
        "gem_card_raw", "metabolic_model_ref", "host_model_binding", "gpr_proof",
        "coupling_profile", "consequence_run", "tier_decision", "numeric_policy",
        "unit_vocabulary", "integration_ruleset", "provenance_dag", "claim",
        "tool_result", "case_manifest",
    ]
    for s in expected_schemas:
        if s not in by_schema:
            missing.append(s)
    ids = [c["id"] for c in CASES]
    assert len(ids) == len(set(ids)), "duplicate case ids"
    if missing:
        raise SystemExit("schemas without cases: " + str(missing))
    doc = {
        "corpus": "synbio-schema-corpus",
        "version": 1,
        "note": "expect = intended verdict; dual-side runners must agree with each other AND with expect",
        "cases": CASES,
    }
    with open(OUT, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write(chr(10))
    n_valid = sum(1 for c in CASES if c["expect"] == "valid")
    print("wrote %s | cases=%d (valid=%d invalid=%d) | schemas=%d" % (OUT, len(CASES), n_valid, len(CASES) - n_valid, len(by_schema)))


if __name__ == "__main__":
    main()
