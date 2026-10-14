#!/usr/bin/env python
"""schemas_a.py — batch A: identity chain (8 schemas).

genome_ref, input_snapshot, host_profile, condition_card, evidence_item,
circuit_design, kinetic_crn_ref, integration_candidate
"""
from schema_helpers import arr, aref, check, dec, obj, sha, schema, sref, ts_

SCHEMAS = {}

SCHEMAS["genome_ref"] = schema(
    "genome_ref",
    "genome_ref@1",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "files", "contigs", "coord_convention", "source"],
        "properties": {
            "artifact_type": {"const": "genome_ref@1"},
            "files": arr("seq", obj(
                {
                    "path": {"type": "string", "minLength": 1, "maxLength": 1024},
                    "sha256": sha(),
                    "format": {"enum": ["fasta", "genbank", "gff3", "other"]},
                },
                ["path", "sha256", "format"],
            )),
            "assembly": {"type": "string", "maxLength": 256},
            "strain": {"type": "string", "maxLength": 256},
            "taxon": {"type": "string", "maxLength": 256},
            "contigs": arr("seq", obj(
                {
                    "name": {"type": "string", "minLength": 1, "maxLength": 512},
                    "length": {"type": "integer", "minimum": 0},
                    "topology": {"enum": ["linear", "circular"]},
                },
                ["name", "length", "topology"],
            )),
            "coord_convention": {"enum": ["0-based-half-open", "1-based-inclusive"]},
            "source": {"type": "string", "minLength": 1, "maxLength": 512},
            "fetched_at": ts_(),
        },
    },
)

SCHEMAS["input_snapshot"] = schema(
    "input_snapshot",
    "input_snapshot@1",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "role", "media_type", "format", "consumer_compatibility", "sha256", "byte_size", "origin"],
        "properties": {
            "artifact_type": {"const": "input_snapshot@1"},
            "role": {"enum": [
                "genome_sequence", "genome_annotation", "condition", "parts_evidence",
                "sbol", "cassette", "gem_model", "gem_card", "coupling_assumption", "other",
            ]},
            "media_type": {"type": "string", "minLength": 1, "maxLength": 128},
            "format": {"enum": ["fasta", "gff3", "genbank", "sbml", "json", "zip", "text", "other"]},
            "consumer_compatibility": arr("set", {"type": "string", "minLength": 1, "maxLength": 64}),
            "sha256": sha(),
            "byte_size": {"type": "integer", "minimum": 0},
            "origin": obj(
                {
                    "kind": {"enum": ["external", "ingest_produced"]},
                    "origin_ref": {"type": "string", "maxLength": 512},
                },
                ["kind"],
            ),
        },
    },
)

SCHEMAS["host_profile"] = schema(
    "host_profile",
    "host_profile@1 (host-side evidence state; no product tier)",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "genome_ref", "evidence_state", "derived", "gates"],
        "properties": {
            "artifact_type": {"const": "host_profile@1"},
            "genome_ref": aref(),
            "evidence_state": obj(
                {
                    "annotation": obj(
                        {"completeness": {"enum": ["full", "partial", "missing"]}, "detail": {"type": "string", "maxLength": 2048}},
                        ["completeness"],
                    ),
                    "condition": obj(
                        {"completeness": {"enum": ["full", "partial", "missing"]}, "detail": {"type": "string", "maxLength": 2048}},
                        ["completeness"],
                    ),
                    "parts_evidence": obj(
                        {
                            "completeness": {"enum": ["full", "partial", "missing"]},
                            "source_id": {"type": "string", "maxLength": 256},
                            "hash": sha(),
                            "levels": arr("set", {"enum": ["E0", "E1", "E2", "E3"]}),
                            "detail": {"type": "string", "maxLength": 2048},
                        },
                        ["completeness"],
                    ),
                },
                ["annotation", "condition", "parts_evidence"],
            ),
            "derived": obj(
                {
                    "genome_size": {"type": "integer", "minimum": 0},
                    "gc_percent": {"type": "number", "minimum": 0, "maximum": 100},
                    "contig_count": {"type": "integer", "minimum": 0},
                    "codon_usage_top": arr("seq", obj(
                        {
                            "codon": {"type": "string", "minLength": 3, "maxLength": 3},
                            "fraction": {"type": "number", "minimum": 0, "maximum": 1},
                        },
                        ["codon", "fraction"],
                    )),
                },
                ["genome_size", "gc_percent", "contig_count"],
            ),
            "condition_ref": aref(),
            "gates": arr("set", check()),
        },
    },
)

SCHEMAS["condition_card"] = schema(
    "condition_card",
    "condition_card@1",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "medium", "culture_mode", "readout"],
        "properties": {
            "artifact_type": {"const": "condition_card@1"},
            "medium": obj(
                {
                    "name": {"type": "string", "maxLength": 256},
                    "carbon_sources": arr("set", {"type": "string", "minLength": 1, "maxLength": 128}),
                    "uptake_definition": {"type": "string", "maxLength": 2048},
                    "oxygen": {"enum": ["aerobic", "microaerobic", "anaerobic", "unspecified"]},
                    "temperature_c": {"type": "number", "minimum": 0, "maximum": 120},
                    "ph": {"type": "number", "minimum": 0, "maximum": 14},
                },
                ["carbon_sources", "oxygen"],
            ),
            "culture_mode": {"enum": ["batch", "fed_batch", "continuous", "unspecified"]},
            "copy_number": obj(
                {
                    "value": {"type": "integer", "minimum": 0},
                    "integration_status": {"enum": ["integrated", "plasmid", "unspecified"]},
                },
                ["integration_status"],
            ),
            "readout": obj(
                {
                    "kind": {"type": "string", "minLength": 1, "maxLength": 256},
                    "unit": {"type": "string", "minLength": 1, "maxLength": 64},
                },
                ["kind", "unit"],
            ),
        },
    },
)

SCHEMAS["evidence_item"] = schema(
    "evidence_item",
    "evidence_item@1",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "source_ref", "host", "readout", "match_grade", "matching_policy"],
        "properties": {
            "artifact_type": {"const": "evidence_item@1"},
            "source_ref": obj(
                {
                    "kind": {"enum": ["doi", "pmid", "url", "lab", "other"]},
                    "id": {"type": "string", "minLength": 1, "maxLength": 512},
                },
                ["kind", "id"],
            ),
            "source_hash": sha(),
            "host": obj(
                {
                    "organism": {"type": "string", "minLength": 1, "maxLength": 256},
                    "strain": {"type": "string", "maxLength": 256},
                    "assembly": {"type": "string", "maxLength": 256},
                },
                ["organism"],
            ),
            "conditions": obj(
                {
                    "medium": {"type": "string", "maxLength": 256},
                    "temperature_c": {"type": "number", "minimum": 0, "maximum": 120},
                    "ph": {"type": "number", "minimum": 0, "maximum": 14},
                },
                [],
            ),
            "part_sequence": obj(
                {
                    "name": {"type": "string", "minLength": 1, "maxLength": 256},
                    "sequence": {"type": "string", "minLength": 1, "maxLength": 100000},
                },
                ["name", "sequence"],
            ),
            "readout": obj(
                {
                    "metric": {"type": "string", "minLength": 1, "maxLength": 256},
                    "value": dec(),
                    "unit": {"type": "string", "minLength": 1, "maxLength": 64},
                    "replicates": {"type": "integer", "minimum": 1},
                },
                ["metric", "value", "unit", "replicates"],
            ),
            "match_grade": {"enum": ["exact", "condition_transfer", "host_transfer", "unknown"]},
            "matching_policy": obj(
                {
                    "id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "version": {"type": "string", "minLength": 1, "maxLength": 64},
                },
                ["id", "version"],
            ),
        },
    },
)

SCHEMAS["circuit_design"] = schema(
    "circuit_design",
    "circuit_design@1",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "source", "template_ref"],
        "properties": {
            "artifact_type": {"const": "circuit_design@1"},
            "source": {"enum": ["sbol_file", "components"]},
            "components": arr("seq", obj(
                {
                    "part_id": {"type": "string", "maxLength": 256},
                    "kind": {"enum": ["promoter", "rbs", "cds", "terminator", "spacer", "other"]},
                    "sequence": {"type": "string", "minLength": 1, "maxLength": 100000},
                },
                ["kind"],
            )),
            "sequence_hashes": arr("set", sha()),
            "orientation": {"enum": ["forward", "reverse", "unspecified"]},
            "constraints": arr("set", {"type": "string", "minLength": 1, "maxLength": 512}),
            "part_refs": arr("set", obj(
                {
                    "part_id": {"type": "string", "minLength": 1, "maxLength": 256},
                    "evidence_level": {"enum": ["E0", "E1", "E2", "E3"]},
                },
                ["part_id", "evidence_level"],
            )),
            "template_ref": obj(
                {
                    "template_id": {"enum": ["expression_balance", "metabolic_valve"]},
                    "version": {"type": "string", "minLength": 1, "maxLength": 64},
                },
                ["template_id", "version"],
            ),
            "parameters": {"type": "object", "additionalProperties": True},
            "conformance": obj(
                {
                    "status": {"enum": ["pass", "fail", "not_run"]},
                    "detail": {"type": "string", "maxLength": 2048},
                },
                ["status"],
            ),
        },
    },
)

SCHEMAS["kinetic_crn_ref"] = schema(
    "kinetic_crn_ref",
    "kinetic_crn_ref@1",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "model_kind", "sbml_ref"],
        "properties": {
            "artifact_type": {"const": "kinetic_crn_ref@1"},
            "model_kind": {"const": "kinetic_crn"},
            "sbml_ref": aref(),
            "compiled_from": obj(
                {
                    "source": {"type": "string", "maxLength": 512},
                    "tool": {"type": "string", "maxLength": 128},
                },
                ["source", "tool"],
            ),
        },
    },
)

SCHEMAS["integration_candidate"] = schema(
    "integration_candidate",
    "integration_candidate@1 (never emits a safety claim)",
    {
        "type": "object",
        "additionalProperties": False,
        "required": ["artifact_type", "genome_ref", "ruleset_ref", "contig", "interval", "strand", "cassette", "classification", "screening_stage", "reasons", "counts"],
        "properties": {
            "artifact_type": {"const": "integration_candidate@1"},
            "genome_ref": aref(),
            "ruleset_ref": aref(),
            "contig": {"type": "string", "minLength": 1, "maxLength": 512},
            "interval": obj(
                {
                    "start": {"type": "integer", "minimum": 0},
                    "end": {"type": "integer", "minimum": 0},
                    "convention": {"const": "0-based-half-open"},
                },
                ["start", "end", "convention"],
            ),
            "strand": {"enum": ["plus", "minus"]},
            "cassette": obj(
                {
                    "sequence_sha256": sha(),
                    "payload_length": {"type": "integer", "minimum": 0},
                    "sequence_identity": {"enum": ["known", "unknown"]},
                },
                ["sequence_identity"],
            ),
            "classification": {"enum": ["excluded", "preliminary_candidate", "screened_candidate", "literature_characterized", "blocked"]},
            "screening_stage": {"enum": ["preliminary_spatial", "sequence_verified"]},
            "reasons": arr("set", obj(
                {
                    "rule_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "code": {"type": "string", "maxLength": 128},
                    "detail": {"type": "string", "maxLength": 2048},
                },
                ["rule_id"],
            )),
            "features_hit": arr("set", {"type": "string", "minLength": 1, "maxLength": 256}),
            "flanking": obj(
                {
                    "left": obj({"start": {"type": "integer", "minimum": 0}, "end": {"type": "integer", "minimum": 0}}, ["start", "end"]),
                    "right": obj({"start": {"type": "integer", "minimum": 0}, "end": {"type": "integer", "minimum": 0}}, ["start", "end"]),
                },
                ["left", "right"],
            ),
            "origin_crossing": {"type": "boolean"},
            "normalized_flank_hashes": obj(
                {"left": sha(), "right": sha()},
                ["left", "right"],
            ),
            "counts": obj(
                {
                    "searched_space": {"type": "integer", "minimum": 0},
                    "excluded": {"type": "integer", "minimum": 0},
                    "unknown": {"type": "integer", "minimum": 0},
                    "mandatory_rule_coverage": arr("set", obj(
                        {
                            "rule_id": {"type": "string", "minLength": 1, "maxLength": 128},
                            "covered": {"type": "integer", "minimum": 0},
                        },
                        ["rule_id", "covered"],
                    )),
                },
                ["searched_space", "excluded", "unknown", "mandatory_rule_coverage"],
            ),
        },
    },
)
