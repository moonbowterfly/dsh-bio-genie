"""Addgene 解析器离线回归测试（用真实响应快照）。

快照来源：2026-09-16 实测抓取，存放于 %TEMP%/addgene.html（52961 详情页）
与 %TEMP%/search.html（lentiCRISPR 搜索页）。改版时用 -live 参数重抓。
"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'python')))
import plasmid_repo as pr  # noqa: E402

T = os.environ.get('LOCALAPPDATA', '') + '/Temp'
out = []


def log(s=''):
    out.append(str(s))


# ---------- A) 搜索页 ----------
log('=== A) 搜索页解析 ===')
page = open(T + '/search.html', encoding='utf-8', errors='replace').read()
total = pr._parse_total(page)
items = pr._parse_result_items(page)
log(f'total_matches={total}  parsed={len(items)}')
assert total == 612, f'预期 612，实际 {total}'
assert len(items) == 20, f'预期 20 条，实际 {len(items)}'
first = items[0]
for k in ('addgene_id', 'name', 'purpose', 'depositor', 'publication', 'insert', 'use'):
    assert first.get(k), f'首条缺字段 {k}: {first}'
log(f'首条: id={first["addgene_id"]} name={first["name"]} insert={first["insert"]}')
log(f'  popularity={first["popularity"]} depositor={first["depositor"]}')
# 全条目字段完整率
have_purpose = sum(1 for i in items if i['purpose'])
have_dep = sum(1 for i in items if i['depositor'])
log(f'字段覆盖: purpose {have_purpose}/20, depositor {have_dep}/20')

# ---------- B) 详情页 ----------
log()
log('=== B) 详情页解析（52961 lentiCRISPR v2）===')
d = open(T + '/addgene.html', encoding='utf-8', errors='replace').read()
fields, sections = pr._parse_detail_fields(d)
log(f'fields={len(fields)}  sections={len(sections)}')
assert len(fields) >= 10, f'字段过少: {fields}'
for k in ('Purpose', 'Bacterial Resistance(s)', 'Copy number', 'Growth Strain(s)',
          'Vector type', 'Selectable markers', 'Total vector size (bp)'):
    v = fields.get(k)
    assert v, f'缺关键字段 {k}；现有键: {sorted(fields)[:25]}'
    log(f'  {k} = {v[:100]}')
log(f'  分节: {list(sections)}')

# ---------- C) 空结果 / 结构变更守护 ----------
log()
log('=== C) 守护逻辑 ===')


class FakeGated:
    """模拟页面自报 6 条结果但结构已变（0 条可解析）。"""
    @staticmethod
    def _parse_total(p):
        return 6


page_empty = '<html>We narrowed to 6 results for: x <li></li></html>'
assert pr._parse_result_items(page_empty) == [], '空结构应解析出 0 条'
log('  ✔ 空结构 → 0 条（可解析）')

# op_plasmid_search 应在 total>0 且 items==0 时抛 AddgeneStructureError


def _fake_fetch(url, timeout=30):
    return page_empty


orig = pr._fetch
pr._fetch = _fake_fetch
try:
    pr.op_plasmid_search({'query': 'x'})
    raise AssertionError('未抛出 AddgeneStructureError —— 响亮失败守护失效！')
except pr.AddgeneStructureError as e:
    log(f'  ✔ 自报有结果却解析 0 条 → 响亮失败: {str(e)[:80]}...')
finally:
    pr._fetch = orig

# ---------- D) 参数校验 ----------
log()
log('=== D) 参数校验 ===')
for bad, exc in [({'query': ''}, ValueError),
                 ({'query': 'x', 'sort': 'bogus'}, ValueError)]:
    try:
        pr.op_plasmid_search(bad)
        raise AssertionError(f'{bad} 未被拒')
    except exc:
        log(f'  ✔ {bad} → {exc.__name__}')
try:
    pr.op_plasmid_info({'plasmid_id': 'abc'})
    raise AssertionError('非法 ID 未被拒')
except ValueError:
    log('  ✔ plasmid_id=abc → ValueError')

log()
log('全部断言通过 ✅')
open(os.path.join(T, 'addgene-parser-test.txt'), 'w', encoding='utf-8').write('\n'.join(out))
print('ALL PASS')
