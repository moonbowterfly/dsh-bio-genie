#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bio_blast_search 短序列防护 + 0 命中诊断的离线回归测试（无真实网络）。

覆盖：
  1) _decide_blast_params（纯函数）：短序列自动参数矩阵 + 严格 expect 告警
  2) _blast_diagnostics（纯函数）：0 命中针对性解释（短序列 / 长序列 / 已自动放宽）
  3) op_blast_search（stub 掉 NCBIWWW.qblast）：返回结构、参数实际透传、
     命中解析不回归、网络异常重试耗尽后的回退文案

用法（仓库根目录）：
  ~/.dsh/dsh-bio-genie/python-env/Scripts/python.exe scripts/test-blast-params.py
  # 或任意装有 biopython 的 python：python scripts/test-blast-params.py
"""
import io
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, '..', 'python'))

FAILURES = 0


def check(cond, msg):
    global FAILURES
    if cond:
        print(f'  PASS {msg}')
    else:
        FAILURES += 1
        print(f'  FAIL {msg}')


from bio_ops import _decide_blast_params, _blast_diagnostics, op_blast_search  # noqa: E402
from Bio.Blast import NCBIWWW  # noqa: E402
import retry_utils  # noqa: E402

SEQ23 = 'ATGCGTACGTAGCTAGCTAGCTA'          # 23 nt（真实事故现场序列长度）
SEQ29 = 'ATGCGTACGTAGCTAGCTAGCTAAGTC'      # 29 nt（边界：仍触发短序列防护）
SEQ30 = 'ATGCGTACGTAGCTAGCTAGCTAAGTCACG'   # 30 nt（边界：不触发短序列防护）
SEQ60 = 'ATGCGTACGTAGCTAGCTAGCTAAGTCACGTAGCTAGCTAGCTAAGTCACGTAGCTAGCTAGCTA'
PROT20 = 'MKTAYILAGHECWDRQPYFG'            # 20 aa（blastp 不应套用 blastn 短序列参数）

# ================================================================ 1) 参数决策
print('[1] _decide_blast_params 纯函数')

kwargs, warnings = _decide_blast_params(SEQ23, 'blastn')
check(kwargs == {'word_size': 7, 'expect': 1000.0}, f'23nt 无参调用自动放宽 → {kwargs}')
check(warnings == [], '自动放宽不产生告警（调用方没传严格阈值）')

kwargs, warnings = _decide_blast_params(SEQ23, 'blastn', user_expect=0.001)
check(kwargs == {'word_size': 7, 'expect': 0.001}, f'显式 expect=0.001 保留调用方值 → {kwargs}')
check(len(warnings) == 1 and 'expect>=10' in warnings[0] and 'len=23' in warnings[0],
      '严格阈值产生 1 条告警（含 len=23 与 expect>=10 建议）')
check('0.1-10' in warnings[0], '告警含「短查询 e-value 0.1-10 量级」解释')

kwargs, warnings = _decide_blast_params(SEQ23, 'blastn', user_word_size=11, user_expect=100)
check(kwargs == {'word_size': 11, 'expect': 100.0}, f'显式 word_size/宽松 expect 原样透传 → {kwargs}')
check(warnings == [], '宽松 expect 不告警')

kwargs, warnings = _decide_blast_params(SEQ23, 'blastn', user_expect=9.99)
check(warnings and kwargs['expect'] == 9.99, 'expect=9.99（<10）仍告警且保留调用方值')

kwargs, warnings = _decide_blast_params(SEQ23, 'blastn', user_expect=10)
check(kwargs == {'word_size': 7, 'expect': 10.0} and warnings == [],
      f'expect=10（阈值边界）不告警 → {kwargs}')

kwargs, warnings = _decide_blast_params(SEQ29, 'blastn')
check(kwargs == {'word_size': 7, 'expect': 1000.0}, f'29nt（<30 边界）仍触发防护 → {kwargs}')

kwargs, warnings = _decide_blast_params(SEQ30, 'blastn')
check(kwargs == {} and warnings == [], f'30nt 不触发短序列防护 → {kwargs}')

kwargs, warnings = _decide_blast_params(SEQ60, 'blastn', user_expect=1e-5)
check(kwargs == {'expect': 1e-05} and warnings == [],
      f'长序列 + 严格 expect 保持历史行为（不改参、不告警）→ {kwargs}')

kwargs, warnings = _decide_blast_params(PROT20, 'blastp')
check(kwargs == {} and warnings == [], f'短蛋白序列不套用 blastn 参数 → {kwargs}')

kwargs, warnings = _decide_blast_params(PROT20, 'blastp', user_expect=0.001)
check(kwargs == {'expect': 0.001} and warnings == [], f'blastp 严格 expect 原样透传 → {kwargs}')

# ================================================================ 2) 诊断生成
print('[2] _blast_diagnostics 纯函数')

_, strict_warnings = _decide_blast_params(SEQ23, 'blastn', user_expect=0.001)
PARAMS_STRICT = {'hitlist_size': 10, 'word_size': 7, 'expect': 0.001}

diag = _blast_diagnostics(SEQ23, 'blastn', PARAMS_STRICT, strict_warnings, hit_count=0)
check(diag['query_length'] == 23, f'diagnostics.query_length=23 → {diag["query_length"]}')
check(diag['params_used'] == PARAMS_STRICT, f'params_used 为参数回执 → {diag["params_used"]}')
check(len(diag['notes']) == 2 and diag['notes'][-1] != strict_warnings[0],
      'notes = 参数告警 + 0 命中解释（两条）')
check(any('参数结果而非服务故障' in n for n in diag['notes']), '0 命中 + 严格 expect：明确「不是服务故障」')
check(any('expect>=10' in n for n in diag['notes']), '0 命中 + 严格 expect：给出 expect>=10 修法')

diag = _blast_diagnostics(SEQ23, 'blastn', {'hitlist_size': 10, 'word_size': 7, 'expect': 1000.0},
                          [], hit_count=0)
check(any('自动放宽参数' in n and 'word_size=7' in n for n in diag['notes']),
      '0 命中 + 已自动放宽：说明「参数已放宽仍无命中」')

diag = _blast_diagnostics(SEQ60, 'blastn', {'hitlist_size': 10}, [], hit_count=0)
check(any('未命中' in n and 'expect' in n for n in diag['notes']), '长序列 0 命中：给出通用放宽建议')

diag = _blast_diagnostics(SEQ23, 'blastn', {'hitlist_size': 10, 'word_size': 7, 'expect': 1000.0},
                          [], hit_count=5)
check(diag['notes'] == [], '有命中时不追加 0 命中解释')

diag = _blast_diagnostics(SEQ23, 'blastn', {'hitlist_size': 10}, ['w1'], hit_count=3)
check(diag['notes'] == ['w1'], '有命中时 notes 仅回放参数告警')

# ================================================================ 3) op 层（stub qblast）
print('[3] op_blast_search（stub NCBIWWW.qblast，无真实网络）')

_XML_HEAD = """<?xml version="1.0"?>
<!DOCTYPE BlastOutput PUBLIC "-//NCBI//NCBI BlastOutput/EN" "http://www.ncbi.nlm.nih.gov/dtd/NCBI_BlastOutput.dtd">
<BlastOutput>
  <BlastOutput_program>blastn</BlastOutput_program>
  <BlastOutput_version>BLASTN 2.15.0+</BlastOutput_version>
  <BlastOutput_reference>offline fixture</BlastOutput_reference>
  <BlastOutput_db>nt</BlastOutput_db>
  <BlastOutput_query-ID>Query_1</BlastOutput_query-ID>
  <BlastOutput_query-def>synthetic query</BlastOutput_query-def>
  <BlastOutput_query-len>{qlen}</BlastOutput_query-len>
  <BlastOutput_param>
    <Parameters>
      <Parameters_expect>10</Parameters_expect>
      <Parameters_sc-match>2</Parameters_sc-match>
      <Parameters_gap-open>5</Parameters_gap-open>
      <Parameters_gap-extend>2</Parameters_gap-extend>
      <Parameters_filter>L;m;</Parameters_filter>
    </Parameters>
  </BlastOutput_param>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_iter-num>1</Iteration_iter-num>
      <Iteration_query-ID>Query_1</Iteration_query-ID>
      <Iteration_query-def>synthetic query</Iteration_query-def>
      <Iteration_query-len>{qlen}</Iteration_query-len>
      <Iteration_hits>
{hits}
      </Iteration_hits>
      <Iteration_stat>
        <Statistics>
          <Statistics_db-num>1000</Statistics_db-num>
          <Statistics_db-len>100000</Statistics_db-len>
          <Statistics_hsp-len>0</Statistics_hsp-len>
          <Statistics_eff-space>1000000</Statistics_eff-space>
          <Statistics_kappa>0.46</Statistics_kappa>
          <Statistics_lambda>1.28</Statistics_lambda>
          <Statistics_entropy>0.78</Statistics_entropy>
        </Statistics>
      </Iteration_stat>
    </Iteration>
  </BlastOutput_iterations>
</BlastOutput>
"""

_XML_HIT = """        <Hit>
          <Hit_num>1</Hit_num>
          <Hit_id>ref|NC_TEST.1|</Hit_id>
          <Hit_def>synthetic test subject</Hit_def>
          <Hit_accession>NC_TEST.1</Hit_accession>
          <Hit_len>500</Hit_len>
          <Hit_hsps>
            <Hsp>
              <Hsp_num>1</Hsp_num>
              <Hsp_bit-score>40.0</Hsp_bit-score>
              <Hsp_score>20</Hsp_score>
              <Hsp_evalue>0.42</Hsp_evalue>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>23</Hsp_query-to>
              <Hsp_hit-from>101</Hsp_hit-from>
              <Hsp_hit-to>123</Hsp_hit-to>
              <Hsp_query-frame>1</Hsp_query-frame>
              <Hsp_hit-frame>1</Hsp_hit-frame>
              <Hsp_identity>23</Hsp_identity>
              <Hsp_positive>23</Hsp_positive>
              <Hsp_gaps>0</Hsp_gaps>
              <Hsp_align-len>23</Hsp_align-len>
              <Hsp_qseq>ATGCGTACGTAGCTAGCTAGCTA</Hsp_qseq>
              <Hsp_hseq>ATGCGTACGTAGCTAGCTAGCTA</Hsp_hseq>
              <Hsp_midline>|||||||||||||||||||||||</Hsp_midline>
            </Hsp>
          </Hit_hsps>
        </Hit>"""

_captured = {}
_real_qblast = NCBIWWW.qblast
_real_sleep = retry_utils.time.sleep


def make_fake(xml_text=None, exc=None):
    def _fake(program, database, sequence, **kwargs):
        _captured.clear()
        _captured.update({'program': program, 'database': database,
                          'sequence': sequence, 'kwargs': kwargs})
        if exc is not None:
            raise exc
        return io.StringIO(xml_text)
    return _fake


# --- 3.1 事故复现：23nt + expect=0.001，服务端 0 命中 ---
NCBIWWW.qblast = make_fake(_XML_HEAD.format(qlen=23, hits=''))
res = op_blast_search({'sequence': SEQ23, 'expect': 0.001})
check(res['hit_count'] == 0 and res['hits'] == [], '23nt + expect=0.001 → 0 命中（复现事故场景）')
check(sorted(res.keys()) >= ['database', 'diagnostics', 'hit_count', 'hits',
                             'program', 'query_length', 'warnings'],
      f'返回结构保留原字段并新增 warnings/diagnostics → {sorted(res.keys())}')
check(res['diagnostics']['params_used'] == {'hitlist_size': 10, 'word_size': 7, 'expect': 0.001},
      f'params_used 与实际传参一致 → {res["diagnostics"]["params_used"]}')
check(_captured['kwargs'] == {'hitlist_size': 10, 'word_size': 7, 'expect': 0.001},
      f'qblast 实际收到 word_size=7（短序列防护真生效）→ {_captured["kwargs"]}')
check(_captured['database'] == 'nt' and _captured['program'] == 'blastn',
      f'program/database 透传不变 → {_captured["program"]}/{_captured["database"]}')
check(res['warnings'] and len(res['warnings']) == 1, '顶层 warnings 回传严格阈值告警')
check(any('参数结果而非服务故障' in n for n in res['diagnostics']['notes']),
      '0 命中有针对性解释（短序列场景判断）')

# --- 3.2 命中解析不回归 ---
NCBIWWW.qblast = make_fake(_XML_HEAD.format(qlen=23, hits=_XML_HIT))
res = op_blast_search({'sequence': SEQ23, 'expect': 0.001, 'hitlist_size': 5})
check(res['hit_count'] == 1 and len(res['hits']) == 1, '命中解析：hit_count/hits 正常')
h = res['hits'][0]
check(h['accession'] == 'NC_TEST.1' and h['evalue'] == 0.42 and h['identity_pct'] == 100.0,
      f'命中字段（accession/evalue/identity_pct）→ {h["accession"]} / {h["evalue"]} / {h["identity_pct"]}')
check(res['diagnostics']['notes'] == res['warnings'] and
      not any(n.startswith('未命中') for n in res['diagnostics']['notes']),
      '有命中：不追加 0 命中解释，参数告警仍在（notes == warnings）')
check(_captured['kwargs']['hitlist_size'] == 5, 'hitlist_size 仍透传')

# --- 3.3 网络异常：重试耗尽路径的回退文案（stub sleep，避免 15s 真实等待）---
sleep_calls = []
retry_utils.time.sleep = lambda s: sleep_calls.append(s)
NCBIWWW.qblast = make_fake(exc=OSError('simulated connection reset'))
raised = None
try:
    op_blast_search({'sequence': SEQ23, 'expect': 0.001})
except BaseException as e:  # noqa: BLE001 - 测试要捕获任意异常类型做断言
    raised = e
check(isinstance(raised, ConnectionError), f'网络异常最终以 ConnectionError 抛出 → {type(raised).__name__}')
check(raised is not None and
      'NCBI BLAST 服务可能暂时不可达或被限流——可稍后重试，或改用 Entrez 直接下载序列做本地比对' in str(raised),
      '重试耗尽文案含指定回退指引')
check(sleep_calls == [5, 10], f'@retry_on_network_error 重试保留（延迟序列 {sleep_calls} → 共 3 次尝试）')

retry_utils.time.sleep = _real_sleep
NCBIWWW.qblast = _real_qblast

print('\nALL PASS' if FAILURES == 0 else f'\n{FAILURES} FAILURES')
sys.exit(0 if FAILURES == 0 else 1)
