#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""op_entrez_search 的 db 报错体验（2026-09-19 审计修复，P2）。

真实会话 c954a395：db='patents' → Bio.Entrez 的
``RuntimeError: Invalid db name specified: patents`` 原样透传，调用方拿不到
任何「有哪些库可用」的信息。修复：识别此类服务端报错，替换为带常用 db 清单
与出处链接的 ValueError（不拦截合法 db，只改善错误路径）。

用法（仓库根目录）：
  node scripts/run-python-test.mjs test/test_entrez_db.py
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, '..', 'python'))

import bio_ops  # noqa: E402

FAILURES = 0


def check(cond, msg):
    global FAILURES
    if cond:
        print(f'  PASS {msg}')
    else:
        FAILURES += 1
        print(f'  FAIL {msg}')


class _FakeHandle:
    def close(self):
        pass


class _FakeEntrezInvalidDb:
    """模拟 NCBI 对未知 db 的行为：Entrez.read 阶段抛 RuntimeError。"""
    email = None

    @staticmethod
    def esearch(db, term, retmax):
        return _FakeHandle()

    @staticmethod
    def read(handle):
        raise RuntimeError('Invalid db name specified: patents')


class _FakeEntrezOk:
    """模拟正常路径：esearch 返回可解析的 IdList。"""
    email = None

    @staticmethod
    def esearch(db, term, retmax):
        return _FakeHandle()

    @staticmethod
    def read(handle):
        return {'IdList': [], 'Count': '0'}


_orig = bio_ops._entrez

# ── 用例 1：未知 db → ValueError 且带常用库清单 ──────────────────────────
bio_ops._entrez = lambda: _FakeEntrezInvalidDb
raised = None
try:
    bio_ops.op_entrez_search({'term': 'BRCA1', 'db': 'patents', 'retmax': 1})
except BaseException as e:  # noqa: BLE001 - 测试要捕获任意异常类型做断言
    raised = e
check(isinstance(raised, ValueError),
      f'未知 db → ValueError（实际 {type(raised).__name__}）')
check(raised is not None and 'patents' in str(raised),
      '报错包含输入的 db 名（可定位问题）')
check(raised is not None and 'pubmed' in str(raised) and 'nucleotide' in str(raised),
      '报错列出常用 db 清单')
check(raised is not None and 'E-utilities' in str(raised),
      '报错说明本工具走 E-utilities 的边界')

# ── 用例 2：正常 db → 不误伤（回归） ─────────────────────────────────────
bio_ops._entrez = lambda: _FakeEntrezOk
ok_raised = None
try:
    out = bio_ops.op_entrez_search({'term': 'BRCA1', 'db': 'nucleotide', 'retmax': 1})
except BaseException as e:  # noqa: BLE001
    ok_raised = e
check(ok_raised is None and isinstance(out, dict) and out.get('ids', None) == [],
      f'正常 db 通路不受影响（raised={ok_raised!r}）')

# ── 用例 3：非 db 类 RuntimeError 不吞（原样上抛） ────────────────────────
class _FakeEntrezOtherError:
    email = None

    @staticmethod
    def esearch(db, term, retmax):
        return _FakeHandle()

    @staticmethod
    def read(handle):
        raise RuntimeError('Server busy, try later')


bio_ops._entrez = lambda: _FakeEntrezOtherError
other = None
try:
    bio_ops.op_entrez_search({'term': 'X', 'db': 'nucleotide', 'retmax': 1})
except BaseException as e:  # noqa: BLE001
    other = e
check(isinstance(other, RuntimeError) and 'Server busy' in str(other),
      f'非 db 类 RuntimeError 原样上抛（实际 {other!r}）')

bio_ops._entrez = _orig

print('\nALL PASS' if FAILURES == 0 else f'\n{FAILURES} FAILURES')
sys.exit(0 if FAILURES == 0 else 1)
