#!/usr/bin/env python
"""schemas_c.py — batch C: policy/governance + embed/audit/container (7 schemas).

numeric_policy, unit_vocabulary, integration_ruleset, provenance_dag,
claim, tool_result, case_manifest
"""
from schema_helpers import arr, aref, check, dec, obj, sha, schema, sref, ts_

SCHEMAS = {}

SCHEMAS["numeric_policy"] = schema(
    "numeric_policy",
    "numeric_policy@1",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "fva_fraction_of_optimum", "solver", "tolerance", "direction_epsilon", "near_zero_rule", "interval_zero_crossing_rule"],
        "properties": {
            "artifact_type": {"const": "numeric_policy@1"},
            "fva_fraction_of_optimum": {"type": "number", "minimum": 0, "maximum": 1},
            "solver": obj(
                {
                    "id": {"type": "string", "minLength": 1, "maxLength": 64},
                    "version": {"type": "string", "minLength": 1, "maxLength": 64},
                },
                ["id", "version"],
            ),
            "tolerance": {"type": "number", "exclusiveMinimum": 0},
            "direction_epsilon": dec(),
            "near_zero_rule": {"type": "string", "minLength": 1, "maxLength": 1024},
            "interval_zero_crossing_rule": {"enum": ["crossing_flags_indeterminate", "crossing_allowed_with_note"]},
        },
    },
)

SCHEMAS["unit_vocabulary"] = schema(
    "unit_vocabulary",
    "unit_vocabulary@1 (units + dimension algebra + forbidden mixes)",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "units", "conversions", "forbidden_mixes"],
        "properties": {
            "artifact_type": {"const": "unit_vocabulary@1"},
            "units": arr("set", obj(
                {
                    "unit_id": {"type": "string", "minLength": 1, "maxLength": 64},
                    "symbol": {"type": "string", "minLength": 1, "maxLength": 32},
                    "dimension": arr("set", obj(
                        {
                            "base": {"enum": ["mass", "length", "time", "amount", "charge", "temperature", "dimensionless"]},
                            "exponent": {"type": "integer"},
                        },
                        ["base", "exponent"],
                    )),
                },
                ["unit_id", "symbol", "dimension"],
            )),
            "conversions": arr("set", obj(
                {
                    "from": {"type": "string", "minLength": 1, "maxLength": 64},
                    "to": {"type": "string", "minLength": 1, "maxLength": 64},
                    "factor": dec(),
                    "note": {"type": "string", "maxLength": 1024},
                },
                ["from", "to", "factor"],
            )),
            "forbidden_mixes": arr("set", obj(
                {
                    "a": {"type": "string", "minLength": 1, "maxLength": 64},
                    "b": {"type": "string", "minLength": 1, "maxLength": 64},
                    "reason": {"type": "string", "minLength": 1, "maxLength": 1024},
                },
                ["a", "b", "reason"],
            )),
        },
    },
)

SCHEMAS["integration_ruleset"] = schema(
    "integration_ruleset",
    "integration_ruleset@1",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "ruleset_id", "version", "rules"],
        "properties": {
            "artifact_type": {"const": "integration_ruleset@1"},
            "ruleset_id": {"type": "string", "minLength": 1, "maxLength": 128},
            "version": {"type": "string", "minLength": 1, "maxLength": 64},
            "rules": arr("set", obj(
                {
                    "rule_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "kind": {"enum": ["feature_overlap", "repeat", "essentiality", "neighborhood", "motif", "other"]},
                    "mandatory": {"type": "boolean"},
                    "params": {"type": "object", "additionalProperties": True},
                    "description": {"type": "string", "maxLength": 1024},
                },
                ["rule_id", "kind", "mandatory"],
            )),
        },
    },
)

SCHEMAS["provenance_dag"] = schema(
    "provenance_dag",
    "provenance_dag@1 (nodes artifact/claim; typed edges; canonical sort + DAG hash)",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "nodes", "edges", "dag_hash"],
        "properties": {
            "artifact_type": {"const": "provenance_dag@1"},
            "nodes": arr("set", obj(
                {
                    "id": sha(),
                    "kind": {"enum": ["artifact", "claim"]},
                    "type": {"type": "string", "minLength": 1, "maxLength": 64},
                },
                ["id", "kind", "type"],
            )),
            "edges": arr("set", obj(
                {
                    "from": sha(),
                    "to": sha(),
                    "kind": {"enum": ["consumes", "derives_from", "supports", "assumes"]},
                },
                ["from", "to", "kind"],
            )),
            "dag_hash": sha(),
        },
    },
)

SCHEMAS["claim"] = schema(
    "claim",
    "claim@1 (embed-only; classification gates mandatory fields)",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["claim_id", "classification", "status"],
        "properties": {
            "claim_id": sha(),
            "classification": {"enum": ["FACT", "ASSUMPTION", "INFERENCE", "BLOCKED"]},
            "status": {"enum": ["SUPPORTED", "CONDITIONAL", "INDETERMINATE", "BLOCKED"]},
            "evidence_refs": arr("set", sha()),
            "assumption_refs": arr("set", sha()),
            "method_ref": {"type": "string", "maxLength": 512},
            "domain_ref": {"type": "string", "maxLength": 512},
            "uncertainty": {"type": "string", "maxLength": 2048},
            "limitations": arr("set", {"type": "string", "minLength": 1, "maxLength": 2048}),
        },
        "allOf": [
            {
                "if": {"type": "object", "properties": {"classification": {"const": "FACT"}}},
                "then": {
                    "type": "object",
                    "required": ["evidence_refs"],
                    "properties": {"evidence_refs": {"type": "array", "minItems": 1}},
                },
            },
            {
                "if": {"type": "object", "properties": {"classification": {"const": "ASSUMPTION"}}},
                "then": {
                    "type": "object",
                    "required": ["assumption_refs"],
                    "properties": {"assumption_refs": {"type": "array", "minItems": 1}},
                },
            },
            {
                "if": {"type": "object", "properties": {"classification": {"const": "INFERENCE"}}},
                "then": {
                    "type": "object",
                    "required": ["method_ref", "domain_ref", "uncertainty"],
                    "properties": {
                        "method_ref": {"type": "string"},
                        "domain_ref": {"type": "string"},
                        "uncertainty": {"type": "string"},
                    },
                },
            },
        ],
    },
)

SCHEMAS["tool_result"] = schema(
    "tool_result",
    "tool_result@1 (audit-only; never a scientific input)",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "audit_only", "status", "generated_by"],
        "properties": {
            "artifact_type": {"const": "tool_result@1"},
            "audit_only": {"const": True},
            "status": {"enum": ["OK", "BLOCKED", "NOT_RUN", "OUT_OF_DOMAIN", "DEPENDENCY_UNAVAILABLE", "INVALID_INPUT", "EXECUTION_ERROR"]},
            "reason_code": {"type": "string", "minLength": 1, "maxLength": 128},
            "reason_codes": arr("set", {"type": "string", "minLength": 1, "maxLength": 128}),
            "artifact_refs": arr("set", aref()),
            "detail": {"type": "string", "maxLength": 8192},
            "input_hashes": arr("set", sha()),
            "producer": {"type": "string", "maxLength": 256},
            "generated_by": {"enum": ["ts_wrapper", "python_worker"]},
            "stderr_summary": {"type": "string", "maxLength": 4096},
        },
    },
)

SCHEMAS["case_manifest"] = schema(
    "case_manifest",
    "case_manifest@1 (canonical snapshot manifest; snapshot_sha = sha256(canonical(doc without snapshot_sha)))",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["schema_version", "case_content_id", "artifacts", "policy"],
        "properties": {
            "schema_version": {"const": "1.0"},
            "case_content_id": sha(),
            "snapshot_sha": sha(),
            "artifacts": arr("set", obj(
                {
                    "artifact_id": sha(),
                    "type": {"enum": [
                        "genome_ref@1", "input_snapshot@1", "host_profile@1", "condition_card@1",
                        "evidence_item@1", "circuit_design@1", "kinetic_crn_ref@1",
                        "integration_candidate@1", "expression_scenario@1", "gem_card_raw@1",
                        "metabolic_model_ref@1", "host_model_binding@1", "gpr_proof@1",
                        "coupling_profile@1", "consequence_run@1", "tier_decision@1",
                        "numeric_policy@1", "unit_vocabulary@1", "integration_ruleset@1",
                        "provenance_dag@1", "case_report@1",
                    ]},
                    "inputs": arr("set", sha()),
                    "producer": {"type": "string", "minLength": 1, "maxLength": 256},
                    "schema_major": {"const": "1"},
                    "canonical_path": {"type": "string", "minLength": 1, "maxLength": 1024},
                },
                ["artifact_id", "type", "inputs", "producer", "schema_major", "canonical_path"],
            )),
            "policy": obj(
                {
                    "policy_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "policy_version": {"type": "string", "minLength": 1, "maxLength": 64},
                    "policy_hash": sha(),
                },
                ["policy_id", "policy_version", "policy_hash"],
            ),
        },
    },
)
