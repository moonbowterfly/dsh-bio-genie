#!/usr/bin/env python
"""test_design_consequence.py — design_consequence v0 核心链测试

覆盖（设计稿 §6）：
  - 锚点：iML1515 好氧葡萄糖最小培养基 baseline growth = 0.876997（冻结锚点逐位复算）
  - 门禁负例：sbml 缺失 / 哈希不符 / card 缺失 / strain 不匹配 / rule 全 miss /
    qualitative / scenarios 空 / 场景 infeasible → INDETERMINATE
  - 确定性：同输入两跑 canonical diff hash 一致；原 SBML 文件哈希不变
  - CLI 冒烟：subprocess 全链一次

外置资产：iML1515（reference bundle，不入仓）；不可用时 skip（fail-closed 语义）。
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "python"))
import design_consequence as dc  # noqa: E402

IML = os.environ.get(
    "DESIGN_TEST_IML1515",
    r"D:\Program\dsh-plug-develop\genie-synbio-design-20261012\reference\iML1515.xml",
)
IML_SHA = "9c772d44ca43350e40dc7ee86c7aa148796856be1eea45e5406c6df8f7dcde28"
BIOMASS = "BIOMASS_Ec_iML1515_core_75p37M"
CARD_GOOD = {"schema_version": "v0-test", "model_sha256": IML_SHA}


def _sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@pytest.fixture(scope="session")
def card_path(tmp_path_factory):
    d = tmp_path_factory.mktemp("card")
    p = d / "card.json"
    p.write_text(json.dumps(CARD_GOOD), encoding="utf-8")
    return str(p)


@pytest.fixture(scope="session")
def loaded_model(card_path):
    if not os.path.exists(IML):
        pytest.skip("iML1515 外置资产不可用（reference bundle 未就位）")
    model, meta = dc.load_model_ref({"sbml_path": IML, "expected_sbml_sha256": IML_SHA, "card_path": card_path})
    return model, meta


# ── 锚点 ─────────────────────────────────────────────────────────────────────

def test_anchor_baseline_growth(loaded_model):
    model, _ = loaded_model
    base = dc.solve_baseline(model, [])
    assert base["status"] == "optimal"
    assert abs(base["objective_value"] - 0.876997) < 1e-5, "锚点漂移：%r" % base["objective_value"]


def test_original_sbml_untouched(loaded_model):
    assert _sha256_file(IML) == IML_SHA


# ── 门禁负例（加载前 fail：快） ───────────────────────────────────────────────

def test_missing_sbml_blocked(card_path):
    with pytest.raises(dc.ToolError) as e:
        dc.load_model_ref({"sbml_path": "Z:/nope.xml", "card_path": card_path})
    assert e.value.code == "BLOCKED"


def test_hash_mismatch_invalid_input(card_path):
    with pytest.raises(dc.ToolError) as e:
        dc.load_model_ref({"sbml_path": IML, "expected_sbml_sha256": "0" * 64, "card_path": card_path})
    assert e.value.code == "INVALID_INPUT"


def test_missing_card_blocked():
    with pytest.raises(dc.ToolError) as e:
        dc.load_model_ref({"sbml_path": IML, "expected_sbml_sha256": IML_SHA})
    assert e.value.code == "BLOCKED"


def test_strain_mismatch_blocked(tmp_path):
    bad = tmp_path / "bad-card.json"
    bad.write_text(json.dumps({"schema_version": "v0-test", "model_sha256": "f" * 64}), encoding="utf-8")
    with pytest.raises(dc.ToolError) as e:
        dc.load_model_ref({"sbml_path": IML, "expected_sbml_sha256": IML_SHA, "card_path": str(bad)})
    assert e.value.code == "BLOCKED"


# ── 门禁负例（需加载：中等成本） ─────────────────────────────────────────────

def test_rule_all_miss_not_run(loaded_model):
    model, _ = loaded_model
    profile = {"rules": [{"rule_id": "r1", "reaction_id": "EX_NOT_EXIST", "operation": "set_upper_bound", "derived_bound": 1}]}
    with pytest.raises(dc.ToolError) as e:
        dc.validate_coupling_profile(profile, model)
    assert e.value.code == "NOT_RUN"  # 禁猜映射


def test_qualitative_rejected(loaded_model):
    model, _ = loaded_model
    profile = {"coupling_mode": "qualitative_direction", "rules": [{"rule_id": "r1"}]}
    with pytest.raises(dc.ToolError) as e:
        dc.validate_coupling_profile(profile, model)
    assert "NO_QUANTITATIVE_COUPLING" in e.value.detail


def test_scenario_infeasible_indeterminate(loaded_model, card_path):
    model, _ = loaded_model
    args = {
        "sbml_path": IML, "expected_sbml_sha256": IML_SHA, "card_path": card_path,
        "medium": [],
        "coupling_profile": {"rules": [{"rule_id": "r1", "reaction_id": "EX_glc__D_e", "operation": "set_lower_bound", "derived_bound": -5}]},
        "scenarios": [{"scenario_id": "forced-infeasible", "modifications": [{"reaction_id": BIOMASS, "lower_bound": 10.0, "upper_bound": 10.0}]}],
    }
    res = dc.op_design_consequence(args)
    assert res["ok"] is True
    assert res["envelope"]["status"] == "NOT_RUN"
    assert res["envelope"]["reason_code"] == "SCENARIO_INDETERMINATE"
    claim = res["consequence_run"]["claims"][0]
    assert claim["status"] == "INDETERMINATE"  # 禁止挑选剩余场景


def test_empty_scenarios_invalid(loaded_model, card_path):
    with pytest.raises(dc.ToolError) as e:
        dc.op_design_consequence({
            "sbml_path": IML, "expected_sbml_sha256": IML_SHA, "card_path": card_path, "medium": [],
            "coupling_profile": {"rules": [{"rule_id": "r1", "reaction_id": "EX_glc__D_e", "operation": "set_lower_bound", "derived_bound": -5}]},
            "scenarios": [],
        })
    assert e.value.code == "INVALID_INPUT"


# ── 正路径 + 确定性 ─────────────────────────────────────────────────────────

def _good_args(card_path):
    return {
        "sbml_path": IML, "expected_sbml_sha256": IML_SHA, "card_path": card_path, "medium": [],
        "coupling_profile": {"rules": [{"rule_id": "r1", "reaction_id": "EX_glc__D_e", "operation": "set_lower_bound", "derived_bound": -5}]},
        "scenarios": [{"scenario_id": "glc5", "target_reaction": BIOMASS}],
    }


def test_positive_and_deterministic(loaded_model, card_path):
    r1 = dc.op_design_consequence(_good_args(card_path))
    r2 = dc.op_design_consequence(_good_args(card_path))
    cr1, cr2 = r1["consequence_run"], r2["consequence_run"]
    assert r1["envelope"]["status"] == "OK"
    assert abs(cr1["baseline"]["objective_value"] - 0.876997) < 1e-5
    assert cr1["applied_rule_ids"] == ["r1"]
    assert cr1["canonical_model_diff_hash"] == cr2["canonical_model_diff_hash"]  # 确定性
    assert cr1["scenarios"][0]["objective_value"] == cr2["scenarios"][0]["objective_value"]
    assert cr1["medium_applied"]["mode"] == "factory_default"


# ── CLI 冒烟（subprocess 全链一次） ─────────────────────────────────────────

def test_cli_smoke(card_path):
    payload = {"op": "design_consequence", "args": _good_args(card_path)}
    p = subprocess.run(
        [sys.executable, "-I", os.path.join(REPO, "python", "design_consequence.py")],
        input=json.dumps(payload), capture_output=True, text=True, timeout=560,
    )
    assert p.returncode == 0
    out = json.loads(p.stdout)
    assert out["ok"] is True
    assert out["envelope"]["status"] == "OK"
