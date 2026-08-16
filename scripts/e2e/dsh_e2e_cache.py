# -*- coding: utf-8 -*-
"""dsh-bio-genie E2E 第六轮:语义工具缓存验证(同参数二次调用命中缓存)。"""
import json
import sys
import time

sys.path.insert(0, r'C:\Users\shuai\deepseek-harness\scripts')
from dsh_bio_client import DshClient  # noqa: E402

dsh = DshClient('http://127.0.0.1:3080/api', timeout=60)
sid = dsh.create_session()
print('[e2e] session:', sid)


def run_task(label, prompt, max_sec=300):
    print(f'[{label}] 发送')
    dsh.send(sid, prompt)
    last = None
    stable = 0
    deadline = time.time() + max_sec
    hv = None
    while time.time() < deadline:
        time.sleep(10)
        hv = dsh.history(sid, max_messages=100)
        text = dsh.extract_latest_text(hv)
        if text and text == last:
            stable += 1
            if stable >= 3:
                return text, hv
        else:
            stable = 0
            if text:
                last = text
                print(f'  ...最新回复 {len(text)} 字符')
    return last, hv


# 两次完全相同的 enrichr 调用
t1, hv1 = run_task('task1', '用 bio_enrichr 对基因列表 TP53, BRCA1, EGFR, MDM2 做 KEGG_2021_Human 富集(top=3),简述结果。')
t2, hv2 = run_task('task2', '再调用一次 bio_enrichr,参数与上次完全相同(TP53, BRCA1, EGFR, MDM2 / KEGG_2021_Human / top=3),只报告是否成功即可。')
print('\n=== task2 回复 ===')
print((t2 or '(无回复)')[:300])

# 从日志查两次调用耗时
import urllib.request
print('\n[证据] 日志中 enrichr 调用记录:')
log_path = r'C:\Users\shuai\.dsh\dsh-bio-genie\log'
import glob, os
today = time.strftime('%Y-%m-%d')
with open(os.path.join(log_path, today + '.jsonl'), encoding='utf-8') as f:
    for line in f:
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get('op') == 'enrichr':
            print(f"  {e['ts'][11:19]} ok={e['ok']} duration={e['duration_ms']}ms")
