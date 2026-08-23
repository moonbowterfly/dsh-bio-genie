/**
 * dsh-bio-genie — 浏览器客户端半面（browser bundle）。
 *
 * 手写零构建版客户端 bundle：声明在 package.json 的 `dsh.client` 与
 * `exports["./client"]`，由 dsh-client-modules 的 Node 半作为 `/plugins/
 * <id>/client.js` 提供，浏览器端模块表（__ModuleLoader__）执行本脚本时调用
 * `load({ id, factory })` 完成注册；factory 仅在首次 import 时物化。
 *
 * apply() 通过 `ctx.slots` 服务注册一个 `settings.section` 条目 —— 即设置
 * 面板侧栏中的一级菜单项「BioGenie」，点击后右侧内容区渲染本插件自己的
 * 设置面板。
 *
 * 面板布局（v0.3.1+）：
 *   - 顶部 tab 切换：总览 / Skill 模块 / Python 环境 / R 环境
 *   - **总览 tab**：包元信息 + 配置默认值只读视图 + 文档导航（v0.3.0 原有）
 *   - **Skill tab**：调 GET /api/dsh-bio-genie/skills 拉主 skill + 48 领域/R/协议 +
 *     9 指南共 50 个条目的元数据，按 category 分组显示（领域/R/协议/指南/主 skill）
 *   - **Python tab**：调 GET /api/dsh-bio-genie/python-packages 拉真实 venv 内 pip list，
 *     表格显示 name + version，按字母排序；venv 未引导时明确标注 + 引导方式
 *   - **R tab**：调 GET /api/dsh-bio-genie/r-packages 拉 Rscript -e 'installed.packages()'
 *     真实结果；R 未引导时同理
 *
 * 数据通道（v0.3.1 新增，loopback-only HTTP RPC）：
 *   - 浏览器 fetch('/api/dsh-bio-genie/<endpoint>') 同源调宿主侧 server.js 注册的路由
 *   - server.js 用 isLoopbackRequest 守卫（127.0.0.1/localhost/sec-fetch-site/origin）
 *   - 返回统一信封 { ok, value } 或 { ok:false, code, message }
 *   - 失败用 ok:false + 机器可读 code（settings-not-exposed/env-not-ready/internal …），
 *     面板据此渲染占位（不是抛错或显示空白）
 *
 * 依赖仅使用静态模块表中的 seed 词（见 packages/client/web/src/seed.ts）：
 *   - 'react'             （React 命名空间，createElement 与 useState）
 *   - 'slots'             cordis 服务，由 @deepseek-ai/dsh-client-runtime 提供
 *
 * 本文件是 classic script + CJS 闭包形态（与 @linxin666 / @deepseek-ai 各客
 * 户端的 tsdown 产物同构），刻意不引入构建工具链，保持插件零构建。
 * 若后续设置面板 UI 复杂化或需要 RPC 拉数据，可平滑迁移到 tsdown 构建
 *（src/client/*.tsx）。
 */
window.__ModuleLoader__.load({
  id: '@dsh-bio/dsh-bio-genie',
  factory: function (require) {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var createElement = React.createElement
    var useState = React.useState

    /**
     * 内联样式（保持最简：深色/浅色主题下均可用，不依赖具体 token；
     * 内容设计阶段后替换为正式的模块化样式）。所有颜色用 currentColor
     * 或半透明 alpha，规避主题差异。
     */
    var styles = {
      section: { maxWidth: '76ch', lineHeight: 1.6 },
      h2: { margin: '0 0 6px', fontSize: '1.1em', fontWeight: 600 },
      lead: { margin: '0 0 14px', opacity: 0.7 },

      // tab 切换条
      tabBar: { display: 'flex', gap: 4, borderBottom: '1px solid currentColor', marginBottom: 16, opacity: 0.85 },
      tab: (active) => ({
        padding: '6px 14px',
        border: '1px solid currentColor',
        borderBottom: active ? '1px solid var(--dsw-alias-bg-layer-2, transparent)' : '1px solid currentColor',
        borderRadius: '6px 6px 0 0',
        marginBottom: active ? '-1px' : 0,
        background: active ? 'var(--dsw-alias-bg-layer-2, transparent)' : 'transparent',
        cursor: 'pointer',
        font: 'inherit',
        fontWeight: active ? 600 : 400,
        color: 'inherit',
        opacity: active ? 1 : 0.7,
      }),

      card: {
        border: '1px solid currentColor',
        borderRadius: 6,
        padding: '12px 14px',
        marginBottom: 14,
      },
      cardTitle: {
        margin: '0 0 8px',
        fontSize: '0.95em',
        fontWeight: 600,
        opacity: 0.85,
      },
      kvTable: { borderCollapse: 'collapse', width: '100%', fontSize: '0.9em' },
      kvKey: {
        padding: '4px 8px 4px 0',
        opacity: 0.6,
        verticalAlign: 'top',
        whiteSpace: 'nowrap',
        width: '40%',
      },
      kvVal: { padding: '4px 0', fontFamily: 'ui-monospace, monospace', fontSize: '0.92em' },

      // skill 列表（按 category 分组）
      groupTitle: {
        margin: '14px 0 6px',
        fontSize: '0.88em',
        fontWeight: 600,
        opacity: 0.7,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      },
      skillItem: { padding: '4px 0', borderBottom: '1px dashed currentColor', opacity: 0.4, fontSize: '0.9em' },
      skillItemLast: { padding: '4px 0' },
      skillName: { fontFamily: 'ui-monospace, monospace', fontSize: '0.92em', marginRight: 8 },
      skillDesc: { opacity: 0.7 },

      // 包列表表格
      pkgTable: { borderCollapse: 'collapse', width: '100%', fontSize: '0.88em' },
      pkgRow: { borderBottom: '1px dashed currentColor', opacity: 0.5 },
      pkgName: { padding: '4px 10px 4px 0', fontFamily: 'ui-monospace, monospace', width: '50%' },
      pkgVer: { padding: '4px 0', fontFamily: 'ui-monospace, monospace', opacity: 0.7 },

      // 加载/错误占位
      status: (kind) => ({
        padding: '14px',
        textAlign: 'center',
        opacity: kind === 'error' ? 0.85 : 0.55,
        fontSize: '0.9em',
      }),

      linkRow: { display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: '0.9em' },
      linkA: { color: 'inherit', textDecoration: 'underline', opacity: 0.85 },
      note: { margin: '8px 0 0', fontSize: '0.85em', opacity: 0.55 },
    }

    /**
     * 静态元信息（浏览器端直接可读，不依赖服务端）。
     */
    var META = {
      pluginName: '@dsh-bio/dsh-bio-genie',
      version: '0.6.0',
      license: 'MIT',
      engines: 'Node ^22.19 || >=24',
      repo: 'https://github.com/moonbowterfly/dsh-bio-genie',
      homepage: 'https://github.com/moonbowterfly/dsh-bio-genie',
      issues: 'https://github.com/moonbowterfly/dsh-bio-genie/issues',
      docsRoot: 'https://github.com/moonbowterfly/dsh-bio-genie/tree/master/docs/agent-guide',
      architectureDoc: 'https://github.com/moonbowterfly/dsh-bio-genie/blob/master/docs/ARCHITECTURE.md',
    }

    /**
     * 默认配置只读视图（与 src/index.js 的 DEFAULT_CONFIG 镜像）。
     */
    var DEFAULT_CONFIG = [
      { key: 'defaultTimeoutMs', value: '60000', desc: 'bio_python 等单次工具调用超时（毫秒）' },
      { key: 'rDefaultTimeoutMs', value: '120000', desc: 'bio_r 工具超时（毫秒），R 引导可能更慢' },
      { key: 'warmUp', value: 'true', desc: '插件加载时后台预热 Python 环境' },
      { key: 'warmUpR', value: 'true', desc: '是否预热 R 环境（默认开启，首次加载约 5-20 分钟）' },
      { key: 'persistentR', value: 'true', desc: 'R 进程常驻（加速后续调用，关闭后每次重新启动 R）' },
      { key: 'enableLog', value: 'true', desc: '是否将执行结果写入 ~/.dsh/dsh-bio-genie/log/*.jsonl' },
      { key: 'enableMemory', value: 'true', desc: '是否沉淀成功模式与失败教训到 ~/.dsh/dsh-bio-genie/memory/' },
      { key: 'pythonEnvDir', value: '$DSH_HOME/dsh-bio-genie/python-env', desc: 'Python venv 目录（默认插件私有）' },
      { key: 'rscriptPath', value: 'auto', desc: 'Rscript 路径（macOS/Linux 需用户配置）' },
      { key: 'rLibDir', value: '$DSH_HOME/dsh-bio-genie/r/r-lib', desc: 'R 私有包库目录' },
    ]

    /**
     * 关键资源链接（agent-guide 文档导航，dsh agent 按需加载）。
     */
    var DOCS = [
      { label: 'agent-guide 总览', href: META.docsRoot + '/README.md', note: '进入 dsh 时自动加载' },
      { label: '工具表', href: META.docsRoot + '/tools.md', note: '31 个语义化工具的字段与适用场景' },
      { label: 'skill 导航', href: META.docsRoot + '/skills.md', note: '40 领域/R + 19 协议 + 9 指南 skill 的领域与语言标注' },
      { label: 'Python 编程', href: META.docsRoot + '/python-cookbook.md', note: 'bio_python 执行器与 bridge 契约' },
      { label: 'R 编程', href: META.docsRoot + '/r-cookbook.md', note: 'bio_r 执行器与 R 4.6/Bioc 3.23 边界' },
      { label: '工作流指南', href: META.docsRoot + '/workflows.md', note: '典型任务的多步协议（DiffExp/GSEA 等）' },
      { label: '绘图指南', href: META.docsRoot + '/plotting.md', note: '出版级 fig 三 op 与样式资产' },
      { label: '排障指南', href: META.docsRoot + '/troubleshooting.md', note: '环境/网络/失败的常见坑' },
      { label: '严谨性指南', href: META.docsRoot + '/rigor.md', note: '数据来源/参数选择/结论可溯源' },
      { label: 'ARCHITECTURE.md', href: META.architectureDoc, note: '维护者向：架构与设计决策' },
    ]

    /**
     * Skill 类别显示名（顺序 = 分组顺序）。
     */
    var CATEGORY_LABELS = [
      { key: 'main',     label: '主 skill' },
      { key: 'domain',   label: 'Biopython 领域' },
      { key: 'research', label: '科研专精' },
      { key: 'r',        label: 'R / Bioconductor 领域' },
      { key: 'protocol', label: '协议库（高频任务工作流）' },
      { key: 'guide',    label: '使用指南（agent 说明书）' },
    ]

    // ---------------------------------------------------------------- RPC

    var RPC_PREFIX = '/api/dsh-bio-genie'

    /**
     * 调一次 RPC。返回统一信封：
     *   { ok: true, value } | { ok: false, code, message }
     * 网络层失败（fetch reject / 非 2xx）也归一成 ok:false code:'network'。
     */
    function rpc(path) {
      return fetch(RPC_PREFIX + path, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'accept': 'application/json' },
      }).then(function (res) {
        return res.json().catch(function () {
          return { ok: false, code: 'bad-json', message: 'response is not JSON (HTTP ' + res.status + ')' }
        })
      }).catch(function (err) {
        return { ok: false, code: 'network', message: err && err.message ? err.message : String(err) }
      })
    }

    // ---------------------------------------------------------------- 组件

    function Card(props) {
      return createElement('section', { style: styles.card },
        createElement('h3', { style: styles.cardTitle }, props.title),
        props.children,
      )
    }

    function Status(props) {
      return createElement('div', { style: styles.status(props.kind || 'loading') }, props.children)
    }

    function MetaCard() {
      return createElement(Card, { title: '插件信息' },
        createElement('table', { style: styles.kvTable },
          createElement('tbody', null,
            kvRow('名称', META.pluginName),
            kvRow('版本', META.version),
            kvRow('许可', META.license),
            kvRow('Node', META.engines),
            kvRow('仓库', createElement('a', { href: META.repo, target: '_blank', rel: 'noreferrer', style: styles.linkA }, META.repo)),
            kvRow('问题反馈', createElement('a', { href: META.issues, target: '_blank', rel: 'noreferrer', style: styles.linkA }, META.issues)),
          ),
        ),
      )
    }

    function ConfigCard() {
      return createElement(Card, { title: '配置默认值（只读视图）' },
        createElement('table', { style: styles.kvTable },
          createElement('tbody', null,
            DEFAULT_CONFIG.map(function (row) {
              return createElement('tr', { key: row.key },
                createElement('td', { style: styles.kvKey },
                  row.key,
                  createElement('br'),
                  createElement('span', { style: { fontSize: '0.9em', opacity: 0.7 } }, row.desc),
                ),
                createElement('td', { style: styles.kvVal }, row.value),
              )
            }),
          ),
        ),
        createElement('p', { style: styles.note },
          '修改配置请编辑 dsh 配置入口（cordis patch yml 的 plugins.<id>.<key>）并重启。',
          '本面板为只读视图；运行时写入将在后续 RPC 通道打通后提供。',
        ),
      )
    }

    /** R 环境设置卡片：可交互开关 */
    function RSettingsCard() {
      var configState = useState({ status: 'loading', persistentR: true, warmUpR: true })
      var cs = configState[0], setCs = configState[1]

      // 加载配置
      useState(function() {
        rpc('/config').then(function(r) {
          if (r.ok) setCs({ status: 'ok', persistentR: r.value.persistentR, warmUpR: r.value.warmUpR })
        })
        return null
      })

      // 切换 persistentR
      function togglePersistentR() {
        var newVal = !cs.persistentR
        rpcPost('/config', { value: newVal }).then(function(r) {
          if (r.ok) setCs({ status: 'ok', persistentR: newVal, warmUpR: cs.warmUpR })
        })
      }

      if (cs.status === 'loading') {
        return createElement(Card, { title: 'R 环境设置' }, createElement(Status, null, '加载中……'))
      }

      return createElement(Card, { title: 'R 环境设置' },
        createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          // persistentR 开关
          createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            createElement('span', { style: { width: 140, fontSize: '0.85em', opacity: 0.7 } }, 'R 进程常驻'),
            createElement('button', {
              onClick: togglePersistentR,
              style: {
                display: 'inline-block', padding: '4px 12px', borderRadius: 4, border: 'none', cursor: 'pointer',
                background: cs.persistentR ? '#2d8a4e' : '#666',
                color: '#fff', fontSize: '0.82em', fontWeight: 600,
              }
            }, cs.persistentR ? '开启 ✓' : '关闭'),
            createElement('span', { style: { fontSize: '0.78em', opacity: 0.5 } },
              'R 进程常驻加速后续调用'),
          ),
          // warmUpR 状态（只读）
          createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            createElement('span', { style: { width: 140, fontSize: '0.85em', opacity: 0.7 } }, 'R 环境预热'),
            createElement('span', {
              style: {
                display: 'inline-block', padding: '3px 10px', borderRadius: 4,
                background: cs.warmUpR ? '#2d8a4e' : '#666',
                color: '#fff', fontSize: '0.82em', fontWeight: 600,
              }
            }, cs.warmUpR ? '开启' : '关闭'),
            createElement('span', { style: { fontSize: '0.78em', opacity: 0.5 } },
              '插件加载时预热 R 环境'),
          ),
          // 说明
          createElement('p', { style: { fontSize: '0.82em', opacity: 0.5, marginTop: 8 } },
            '切换 persistentR 后需重启 dsh 才能生效。warmUpR 需编辑 cordis.patch.yml。',
          ),
        ),
      )
    }

    function DocsCard() {
      return createElement(Card, { title: '文档导航' },
        createElement('div', { style: styles.linkRow },
          DOCS.map(function (d) {
            return createElement('a', { key: d.href, href: d.href, target: '_blank', rel: 'noreferrer', style: styles.linkA },
              d.label,
              createElement('span', { style: styles.note }, ' · ', d.note),
            )
          }),
        ),
      )
    }

    function kvRow(key, value) {
      return createElement('tr', { key: key },
        createElement('td', { style: styles.kvKey }, key),
        createElement('td', { style: styles.kvVal }, value),
      )
    }

    // ---------------------------------------------------------------- Skill tab

    /**
     * Skill 模块视图：从 /api/dsh-bio-genie/skills 拉数据后按 category 分组展示。
     * 三种状态：loading / ok / err（err 含 code + message，区分网络/路由/解析）。
     */
    function SkillsView() {
      var state = useState({ status: 'loading', data: null, error: null })
      var s = state[0], set = state[1]

      function reload() {
        set({ status: 'loading', data: null, error: null })
        rpc('/skills').then(function (r) {
          if (r.ok) set({ status: 'ok', data: r.value, error: null })
          else set({ status: 'err', data: null, error: r })
        })
      }

      // 首次挂载拉数据
      useState(function () {
        reload()
        return null
      })

      if (s.status === 'loading') {
        return createElement(Card, { title: 'Skill 模块' },
          createElement(Status, { kind: 'loading' }, '加载中……'),
        )
      }
      if (s.status === 'err') {
        return createElement(Card, { title: 'Skill 模块' },
          createElement(Status, { kind: 'error' }, '加载失败：', s.error.code, ' · ', s.error.message || ''),
          createElement('p', { style: styles.note },
            '点击 ',
            createElement('button', { onClick: reload, style: { background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', padding: 0 } }, '重试'),
            ' 或刷新面板',
          ),
        )
      }

      // 按 category 分组（保持 CATEGORY_LABELS 定义的顺序）
      var byCat = {}
      for (var i = 0; i < CATEGORY_LABELS.length; i++) byCat[CATEGORY_LABELS[i].key] = []
      // 主 skill
      if (s.data.main) byCat.main.push(s.data.main)
      for (var j = 0; j < s.data.skills.length; j++) {
        var sk = s.data.skills[j]
        if (!byCat[sk.category]) byCat[sk.category] = []
        byCat[sk.category].push(sk)
      }
      for (var k = 0; k < s.data.guides.length; k++) {
        var g = s.data.guides[k]
        if (!byCat[g.category]) byCat[g.category] = []
        byCat[g.category].push(g)
      }

      return createElement(Card, { title: 'Skill 模块（' + countSkills(s.data) + ' 个）' },
        CATEGORY_LABELS.map(function (cat) {
          var items = byCat[cat.key] || []
          if (items.length === 0) return null
          return createElement('div', { key: cat.key },
            createElement('h4', { style: styles.groupTitle }, cat.label, '（' + items.length + '）'),
            items.map(function (item, idx) {
              var isLast = idx === items.length - 1
              return createElement('div', { key: item.name, style: isLast ? styles.skillItemLast : styles.skillItem },
                createElement('span', { style: styles.skillName }, item.name),
                createElement('span', { style: styles.skillDesc }, item.description),
              )
            })
          )
        }),
        createElement('p', { style: styles.note },
          '数据来自 /api/dsh-bio-genie/skills（loopback-only RPC，由 ',
          createElement('code', null, 'src/server.js'),
          ' 提供）。',
          createElement('button', { onClick: reload, style: { background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', padding: 0, marginLeft: 4 } }, '重新加载'),
        ),
      )
    }

    function countSkills(data) {
      return (data.main ? 1 : 0) + data.skills.length + data.guides.length
    }

    // ---------------------------------------------------------------- 包列表 tab

    /**
     * Python 包列表视图：从 /api/dsh-bio-genie/python-packages 拉 pip list JSON。
     * 失败原因在面板里直接展示（env-not-ready / network / parse-failed …）。
     */
    function PythonView() {
      var state = useState({ status: 'loading', data: null, error: null })
      var s = state[0], set = state[1]

      function reload() {
        set({ status: 'loading', data: null, error: null })
        rpc('/python-packages').then(function (r) {
          if (r.ok) set({ status: 'ok', data: r.value, error: null })
          else set({ status: 'err', data: null, error: r })
        })
      }
      useState(function () { reload(); return null })

      if (s.status === 'loading') {
        return createElement(Card, { title: '内置 Python 环境' },
          createElement(Status, { kind: 'loading' }, '加载中……（spawn pip list）'),
        )
      }
      if (s.status === 'err') {
        return createElement(Card, { title: '内置 Python 环境' },
          createElement(Status, { kind: 'error' }, errTitle(s.error), s.error.code, ' · ', s.error.message || ''),
          createElement('p', { style: styles.note },
            envReadyHint(s.error.code),
            ' · ',
            createElement('button', { onClick: reload, style: { background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', padding: 0 } }, '重试'),
          ),
        )
      }
      var d = s.data
      return createElement(Card, { title: '内置 Python 环境（' + d.count + ' 个包）' },
        createElement('div', { style: { fontSize: '0.85em', opacity: 0.7, marginBottom: 10 } },
          '解释器：', createElement('code', null, d.python),
          createElement('br'),
          'venv 目录：', createElement('code', null, d.envDir),
        ),
        createElement(PackageTable, { packages: d.packages }),
        createElement('p', { style: styles.note },
          '数据来自 ',
          createElement('code', null, d.python + ' -I -m pip list --format=json'),
          '（loopback RPC）。',
          createElement('button', { onClick: reload, style: { background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', padding: 0, marginLeft: 4 } }, '重新加载'),
        ),
      )
    }

    function RView() {
      var state = useState({ status: 'loading', data: null, error: null })
      var s = state[0], set = state[1]

      function reload() {
        set({ status: 'loading', data: null, error: null })
        rpc('/r-packages').then(function (r) {
          if (r.ok) set({ status: 'ok', data: r.value, error: null })
          else set({ status: 'err', data: null, error: r })
        })
      }
      useState(function () { reload(); return null })

      if (s.status === 'loading') {
        return createElement(Card, { title: '内置 R 环境' },
          createElement(Status, { kind: 'loading' }, '加载中……（spawn Rscript installed.packages()）'),
        )
      }
      if (s.status === 'err') {
        return createElement(Card, { title: '内置 R 环境' },
          createElement(Status, { kind: 'error' }, errTitle(s.error), s.error.code, ' · ', s.error.message || ''),
          createElement('p', { style: styles.note },
            envReadyHint(s.error.code),
            ' · ',
            createElement('button', { onClick: reload, style: { background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', padding: 0 } }, '重试'),
          ),
        )
      }
      var d = s.data
      return createElement(Card, { title: '内置 R 环境（' + d.count + ' 个包）' },
        createElement('div', { style: { fontSize: '0.85em', opacity: 0.7, marginBottom: 10 } },
          'Rscript：', createElement('code', null, d.rscript),
          createElement('br'),
          'R 私有包库：', createElement('code', null, d.libDir),
        ),
        createElement(PackageTable, { packages: d.packages }),
        createElement('p', { style: styles.note },
          '数据来自 ',
          createElement('code', null, 'Rscript --vanilla -e "toJSON(installed.packages()[,c(Package,Version)])"'),
          '（loopback RPC）。',
          createElement('button', { onClick: reload, style: { background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', padding: 0, marginLeft: 4 } }, '重新加载'),
        ),
      )
    }

    function PackageTable(props) {
      var pkgs = props.packages || []
      return createElement('table', { style: styles.pkgTable },
        createElement('tbody', null,
          pkgs.map(function (p) {
            return createElement('tr', { key: p.name, style: styles.pkgRow },
              createElement('td', { style: styles.pkgName }, p.name),
              createElement('td', { style: styles.pkgVer }, p.version),
            )
          })
        ),
      )
    }

    function errTitle(err) {
      if (!err) return ''
      if (err.code === 'env-not-ready') return '环境未就绪：'
      if (err.code === 'network') return 'RPC 网络失败：'
      if (err.code === 'parse-failed') return '解析失败：'
      if (err.code === 'internal') return '服务器内部错误：'
      return '加载失败：'
    }

    function envReadyHint(code) {
      if (code === 'env-not-ready') return '首次调用 bio_python / bio_r 即会触发引导（下载 uv + Python + 装包可能几分钟；R 首次约 5-20 分钟）'
      if (code === 'network') return 'RPC 路由未注册或被代理拦截——确认 dsh 实例已加载最新插件（含 src/server.js）'
      return ''
    }

    // ---------------------------------------------------------------- 工具调试 tab

    /** POST 调用 RPC（用于工具执行）。 */
    function rpcPost(path, body) {
      return fetch(RPC_PREFIX + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.json().catch(function () {
          return { ok: false, code: 'bad-json', message: 'response is not JSON (HTTP ' + res.status + ')' }
        })
      }).catch(function (err) {
        return { ok: false, code: 'network', message: err && err.message ? err.message : String(err) }
      })
    }

    /**
     * 工具调试视图：选择工具 → 填参数 → 执行 → 查看结果。
     * 工具 schema 通过 GET /api/dsh-bio-genie/tool-schemas 获取。
     */
    function ToolDebugView() {
      var schemasState = useState({ status: 'loading', data: null })
      var schemas = schemasState[0], setSchemas = schemasState[1]
      var selectedState = useState(null)    // 当前选中的 tool schema
      var selected = selectedState[0], setSelected = selectedState[1]
      var argsState = useState({})          // 参数值
      var args = argsState[0], setArgs = argsState[1]
      var execState = useState({ status: 'idle', data: null, error: null })  // 执行状态
      var exec = execState[0], setExec = execState[1]

      // 首次挂载加载 tool schemas
      useState(function () {
        rpc('/tool-schemas').then(function (r) {
          if (r.ok) setSchemas({ status: 'ok', data: r.value })
          else setSchemas({ status: 'err', data: null, error: r })
        })
        return null
      })

      // 选择工具时重置参数和结果
      function selectTool(tool) {
        setSelected(tool)
        var initArgs = {}
        if (tool.params) {
          tool.params.forEach(function (p) {
            if (p.default !== undefined) initArgs[p.key] = p.default
          })
        }
        setArgs(initArgs)
        setExec({ status: 'idle', data: null, error: null })
      }

      // 执行工具
      function executeTool() {
        if (!selected) return
        setExec({ status: 'running', data: null, error: null })
        rpcPost('/execute-tool', { op: selected.name, args: args }).then(function (r) {
          if (r.ok) setExec({ status: 'ok', data: r.result || r, error: null })
          else setExec({ status: 'error', data: null, error: r })
        })
      }

      // 更新参数值
      function updateArg(key, value) {
        var next = Object.assign({}, args)
        next[key] = value
        setArgs(next)
      }

      if (schemas.status === 'loading') {
        return createElement(Card, { title: '工具调试' }, createElement(Status, null, '加载工具列表……'))
      }
      if (schemas.status === 'err') {
        return createElement(Card, { title: '工具调试' }, createElement(Status, { kind: 'error' }, '加载失败'))
      }

      var tools = schemas.data || []

      return createElement('div', null,
        // 工具选择下拉
        createElement(Card, { title: '工具调试（' + tools.length + ' 个可调试工具）' },
          createElement('div', { style: { marginBottom: 12 } },
            createElement('label', { style: { fontSize: '0.85em', opacity: 0.7 } }, '选择工具：'),
            createElement('select', {
              style: { marginLeft: 8, padding: '4px 8px', background: 'var(--dsw-alias-bg-layer-1, #222)', color: 'inherit', border: '1px solid currentColor', borderRadius: 4, fontSize: '0.9em' },
              value: selected ? selected.name : '',
              onChange: function (e) {
                var name = e.target.value
                var tool = tools.find(function (t) { return t.name === name })
                if (tool) selectTool(tool)
              },
            },
              createElement('option', { value: '' }, '-- 请选择 --'),
              tools.map(function (t) {
                return createElement('option', { key: t.name, value: t.name }, t.label + ' (' + t.name + ')')
              })
            ),
            selected ? createElement('span', { style: { marginLeft: 8, fontSize: '0.8em', opacity: 0.5 } },
              selected.engine === 'python' ? '🐍 Python' : '📊 R'
            ) : null,
          ),
        ),

        // 参数表单（选中工具后显示）
        selected ? createElement(Card, { title: '参数 — ' + selected.label },
          createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            (selected.params || []).map(function (p) {
              var isBool = p.type === 'boolean'
              var isSelect = p.type === 'select'
              var isNum = p.type === 'number'
              var val = args[p.key] !== undefined ? args[p.key] : (p.default !== undefined ? p.default : '')

              return createElement('div', { key: p.key, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                createElement('label', { style: { width: 140, fontSize: '0.85em', opacity: 0.7, textAlign: 'right', flexShrink: 0 } },
                  p.key,
                  p.required ? createElement('span', { style: { color: '#f66' } }, ' *') : null,
                ),
                isBool
                  ? createElement('input', { type: 'checkbox', checked: !!val, onChange: function (e) { updateArg(p.key, e.target.checked) } })
                  : isSelect
                    ? createElement('select', {
                        style: { flex: 1, padding: '4px 8px', background: 'var(--dsw-alias-bg-layer-1, #222)', color: 'inherit', border: '1px solid currentColor', borderRadius: 4, fontSize: '0.9em' },
                        value: val,
                        onChange: function (e) { updateArg(p.key, e.target.value) },
                      },
                        (p.options || []).map(function (opt) {
                          return createElement('option', { key: opt, value: opt }, opt)
                        })
                      )
                    : createElement('input', {
                        type: isNum ? 'number' : 'text',
                        style: { flex: 1, padding: '4px 8px', background: 'var(--dsw-alias-bg-layer-1, #222)', color: 'inherit', border: '1px solid currentColor', borderRadius: 4, fontSize: '0.9em', fontFamily: 'ui-monospace, monospace' },
                        placeholder: p.placeholder || '',
                        value: val,
                        onChange: function (e) { updateArg(p.key, isNum ? Number(e.target.value) : e.target.value) },
                      }),
                createElement('span', { style: { fontSize: '0.78em', opacity: 0.45, flexShrink: 0 } }, p.desc),
              )
            })
          ),
          createElement('div', { style: { marginTop: 12 } },
            createElement('button', {
              onClick: executeTool,
              disabled: exec.status === 'running',
              style: {
                padding: '6px 18px', background: exec.status === 'running' ? 'transparent' : 'var(--dsw-alias-accent, #4a9eff)',
                color: exec.status === 'running' ? 'inherit' : '#fff', border: 'none', borderRadius: 4, cursor: exec.status === 'running' ? 'wait' : 'pointer',
                fontSize: '0.9em', fontWeight: 600, opacity: exec.status === 'running' ? 0.5 : 1,
              },
            }, exec.status === 'running' ? '执行中……' : '▶ 执行'),
          ),
        ) : null,

        // 执行结果
        exec.status !== 'idle' ? createElement(Card, { title: '执行结果' },
          exec.status === 'running'
            ? createElement(Status, null, '正在执行 ' + (selected ? selected.label : '') + '……')
            : exec.status === 'error'
              ? createElement('div', { style: { color: '#f88', fontSize: '0.9em' } },
                  createElement('strong', null, '错误：'),
                  exec.error ? (exec.error.message || exec.error.code || JSON.stringify(exec.error)) : '未知错误',
                )
              : createElement('pre', {
                  style: {
                    background: 'var(--dsw-alias-bg-layer-1, #1a1a1a)', padding: 12, borderRadius: 6,
                    fontSize: '0.82em', fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all', maxHeight: 500, overflow: 'auto', margin: 0,
                  },
                }, JSON.stringify(exec.data, null, 2))
        ) : null,
      )
    }

    // ---------------------------------------------------------------- 总览 tab

    function OverviewTab() {
      return createElement('div', null,
        createElement(MetaCard, null),
        createElement(ConfigCard, null),
        createElement(RSettingsCard, null),
        createElement(DocsCard, null),
      )
    }

    // ---------------------------------------------------------------- 容器

    /**
     * 设置面板内容区。owner props 为 { close }；当前未使用。
     * 内部维护 tab 状态：'overview' | 'skills' | 'python' | 'r'。
     */
    function BioGenieSection() {
      var tabState = useState('overview')
      var tab = tabState[0], setTab = tabState[1]

      var tabs = [
        { key: 'overview', label: '总览' },
        { key: 'skills',   label: 'Skill 模块' },
        { key: 'debug',    label: '工具调试' },
        { key: 'python',   label: 'Python 环境' },
        { key: 'r',        label: 'R 环境' },
      ]

      return createElement('div', { className: 'biogenie-settings', style: styles.section },
        createElement('h2', { className: 'biogenie-settings-title', style: styles.h2 }, 'BioGenie 设置'),
        createElement('p', { className: 'biogenie-settings-lead', style: styles.lead },
          '生物信息学「许愿式分析」插件 — 双引擎执行器（Biopython + R 4.6 / Bioc 3.23）、',
          '31 个语义化工具、48 个 skill、零依赖自举双环境。',
        ),
        createElement('div', { role: 'tablist', style: styles.tabBar },
          tabs.map(function (t) {
            var active = t.key === tab
            return createElement('button', {
              key: t.key,
              role: 'tab',
              'aria-selected': active,
              onClick: function () { setTab(t.key) },
              style: styles.tab(active),
            }, t.label)
          }),
        ),
        tab === 'overview' ? createElement(OverviewTab, null)
          : tab === 'skills' ? createElement(SkillsView, null)
          : tab === 'debug'  ? createElement(ToolDebugView, null)
          : tab === 'python' ? createElement(PythonView, null)
          : tab === 'r'      ? createElement(RView, null)
          : null,
      )
    }

    /**
     * 浏览器端插件入口：注册设置面板侧栏一级菜单「BioGenie」。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'biogenie',
          order: 50,
          label: 'BioGenie',
        }, BioGenieSection)
      })
    }

    exports.apply = apply
    exports.inject = ['slots']

    return module.exports
  },
})