#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bio_python bridge 的 result 规范化回归测试（2026-10-04）。

背景：真实会话中 agent 用 bio_python 做 cobra 计算后返回 numpy 标量，
工具层报 `value is not lossless JSON`（dsh snapshot 校验拒绝 -0.0/NaN/Inf），
agent 被迫显式 float() 转换自愈。修复：bridge._normalize_json_value 对
numpy 标量/数组做原生转换，-0.0→0.0、NaN/±inf→null，其余递归规范化。

用法（仓库根目录）：
  node scripts/run-python-test.mjs test/test_bridge_sanitize.py
"""
import json
import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
PY = os.path.join(os.path.expanduser('~'), '.dsh', 'dsh-bio-genie',
                  'python-env', 'Scripts', 'python.exe')
FAILURES = 0


def check(cond, msg):
    global FAILURES
    if cond:
        print(f'  PASS {msg}')
    else:
        FAILURES += 1
        print(f'  FAIL {msg}')


def run_bridge(code):
    payload = json.dumps({'code': code})
    p = subprocess.run([PY, '-I', os.path.join(_REPO, 'python', 'bridge.py')],
                       input=payload.encode('utf-8'), capture_output=True, timeout=180)
    return p.stdout.decode('utf-8'), p.stderr.decode('utf-8')


print('== bridge result 规范化 ==')
code = ("import numpy as np; "
        "result = {"
        "'neg0': np.float64(-0.0), "
        "'nan': float('nan'), "
        "'inf': np.float64(float('inf')), "
        "'ninf': float('-inf'), "
        "'arr': np.array([1.0, np.float64(2.5)]), "
        "'nested': {'v': np.int64(7), 'flag': np.bool_(True)}, "
        "'ok': 1.5, "
        "'s': 'text'"
        "}")
raw, err = run_bridge(code)
out = json.loads(raw)
r = out.get('result') or {}
check(out.get('ok') is True, 'bridge 正常返回 ok=true')
check(repr(r.get('neg0')) == '0.0', f"-0.0 → 0.0（实际 {r.get('neg0')!r}）")
check(r.get('nan') is None and r.get('inf') is None and r.get('ninf') is None,
      'NaN / +inf / -inf → null')
check(r.get('arr') == [1.0, 2.5], f'ndarray → 原生 list（实际 {r.get("arr")!r}）')
check(r.get('nested', {}).get('v') == 7 and isinstance(r['nested']['v'], int),
      'np.int64 → int')
check(r.get('nested', {}).get('flag') is True, 'np.bool_ → bool')
check(r.get('ok') == 1.5 and r.get('s') == 'text', '常规值原样通过')
check('NaN' not in raw and 'Infinity' not in raw,
      '原始 stdout 为严格 JSON（无 NaN/Infinity 字样）')

print('== 不可序列化叶子回退 ==')
raw2, _ = run_bridge("result = {'o': object(), 'keep': 1}")
r2 = json.loads(raw2).get('result') or {}
check(isinstance(r2.get('o'), str) and r2.get('keep') == 1,
      f'不可序列化对象回退为 repr 字符串（实际 {type(r2.get("o")).__name__}）')

print('== 无 result 变量 ==')
raw3, _ = run_bridge("x = 1")
out3 = json.loads(raw3)
check(out3.get('ok') is True and out3.get('result') is None, '无 result 时返回 null')

print()
print('ALL PASS' if FAILURES == 0 else f'{FAILURES} FAILURES')
sys.exit(0 if FAILURES == 0 else 1)
