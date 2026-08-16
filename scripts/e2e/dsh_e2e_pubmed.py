# -*- coding: utf-8 -*-
"""dsh-bio-genie E2E 第二轮:验证 pubmed_search/pubmed_abstract/ref_genome 三工具。"""
import json
import sys
import time

sys.path.insert(0, r'C:\Users\shuai\deepseek-harness\scripts')
from dsh_bio_client import DshClient  # noqa: E402

dsh = DshClient('http://127.0.0.1:3080/api', timeout=60)

sid = dsh.create_session()
print('[e2e] session:', sid)

task = ('请依次完成:1) 用 bio_pubmed_search 检索 "CRISPR prime editing" 取 2 篇;'
        '2) 用 bio_pubmed_abstract 取这两篇的摘要;'
        '3) 用 bio_ref_genome 查 human 的参考基因组 assembly 名。'
        '最后汇总:两篇文献的标题/期刊/DOI 片段,以及人类参考基因组版本。')
dsh.send(sid, task)
print('[e2e] task sent')

deadline = time.time() + 480
last_text = None
stable = 0
while time.time() < deadline:
    time.sleep(12)
    hv = dsh.history(sid, max_messages=100)
    text = dsh.extract_latest_text(hv)
    if text and text == last_text:
        stable += 1
        if stable >= 3:
            print('[e2e] 回复稳定,判定完成')
            break
    else:
        stable = 0
        if text:
            last_text = text
            print(f'[e2e] ...最新回复 {len(text)} 字符')

print('\n=== 最终回复 ===')
print((last_text or '(无回复)')[:2000])
