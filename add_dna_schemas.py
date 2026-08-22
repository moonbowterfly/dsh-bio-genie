"""将 DNA 设计工具 schemas 追加到 server.js + client.js"""
import re

dna_schemas = """  { name: 'primer_design', label: '引物设计', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCGATCG...', desc: '模板 DNA 序列' },
    { key: 'product_size', type: 'number', default: 500, desc: '产物大小(bp)' },
    { key: 'tm_target', type: 'number', default: 60, desc: '目标 Tm(°C)' },
  ]},
  { name: 'seq_optimize', label: '密码子优化', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGTAAAGAT...', desc: '编码序列(CDS)' },
    { key: 'organism', type: 'select', options: ['ecoli','human','yeast'], default: 'ecoli', desc: '宿主生物' },
  ]},
  { name: 'assembly_design', label: '组装设计', engine: 'python', params: [
    { key: 'fragments', type: 'text', required: true, placeholder: 'seq1,seq2,seq3', desc: 'DNA 片段（逗号分隔）' },
    { key: 'method', type: 'select', options: ['auto','gibson','golden_gate','restriction'], default: 'auto', desc: '组装方法' },
  ]},
  { name: 'plasmid_map', label: '质粒图谱', engine: 'python', params: [
    { key: 'name', type: 'text', default: 'plasmid', desc: '质粒名称' },
    { key: 'size', type: 'number', default: 5000, desc: '总大小(bp)' },
    { key: 'features', type: 'text', placeholder: '[{"name":"promoter","start":0,"end":200,"type":"regulatory"}]', desc: '特征列表(JSON)' },
  ]},
"""

for filepath in ['src/server.js', 'lib/client.js']:
    with open(filepath, 'r') as f:
        content = f.read()
    marker = "  { name: 'stats_test',"
    # 找到 stats_test 条目的结束位置
    idx = content.find(marker)
    if idx == -1:
        print(f'WARNING: marker not found in {filepath}')
        continue
    # 找到该条目的结束 "]}," 
    end_idx = content.find(']},', idx) + 3
    content = content[:end_idx] + '\n' + dna_schemas + content[end_idx:]
    with open(filepath, 'w') as f:
        f.write(content)
    print(f'✅ {filepath} DNA schemas 添加完成')
