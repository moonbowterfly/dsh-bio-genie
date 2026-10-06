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
 *   - 顶部 tab 切换：总览 / Skill 模块 / Python 环境
 *   - **总览 tab**：包元信息 + 配置默认值只读视图 + 文档导航（v0.3.0 原有）
 *   - **Skill tab**：调 GET /api/dsh-bio-genie/skills 拉主 skill + 领域/研究/协议 +
 *     指南条目的元数据，按 category 分组显示（领域/研究/协议/指南/主 skill）
 *   - **Python tab**：调 GET /api/dsh-bio-genie/python-packages 拉真实 venv 内 pip list，
 *     表格显示 name + version，按字母排序；venv 未引导时明确标注 + 引导方式
 *   - （R 引擎已移除：不再提供 R 环境 tab 与 r-packages 端点）
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
 *   - 'slots'             cordis 服务，由 0.2.0 的 dsh-client-ui-renderer 提供
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
    var useEffect = React.useEffect
    var useRef = React.useRef

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
      version: '0.6.43',
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
      { key: 'warmUp', value: 'true', desc: '插件加载时后台预热 Python 环境' },
      { key: 'enableLog', value: 'true', desc: '是否将执行结果写入 ~/.dsh/dsh-bio-genie/log/*.jsonl' },
      { key: 'enableMemory', value: 'true', desc: '是否沉淀成功模式与失败教训到 ~/.dsh/dsh-bio-genie/memory/' },
      { key: 'pythonEnvDir', value: '$DSH_HOME/dsh-bio-genie/python-env', desc: 'Python venv 目录（默认插件私有）' },
    ]

    /**
     * 关键资源链接（agent-guide 文档导航，dsh agent 按需加载）。
     */
    var DOCS = [
      { label: 'agent-guide 总览', href: META.docsRoot + '/README.md', note: '进入 dsh 时自动加载' },
      { label: '工具表', href: META.docsRoot + '/tools.md', note: '57 个语义化工具的字段与适用场景' },
      { label: 'skill 导航', href: META.docsRoot + '/skills.md', note: '22 领域/研究 + 17 协议 + 8 指南 skill 的领域与语言标注' },
      { label: 'Python 编程', href: META.docsRoot + '/python-cookbook.md', note: 'bio_python 执行器与 bridge 契约' },
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

    // ---------------------------------------------------------------- 高级模块 tab

    /**
     * 高级功能模块视图（第三层 ADDON_MODULES）：每行一个模块，
     * 展示名称/描述/体积/包清单/安装状态，提供一键安装与卸载。
     * 数据与操作走 /api/dsh-bio-genie/addons（GET 状态 / POST install|uninstall）。
     */
    function AddonsView() {
      var state = useState({ status: 'loading', data: null, error: null })
      var s = state[0], set = state[1]
      var busy = useState(null) // 正在安装/卸载的模块 key
      var busyKey = busy[0], setBusy = busy[1]

      function reload() {
        set({ status: 'loading', data: null, error: null })
        rpc('/addons').then(function (r) {
          if (r.ok) set({ status: 'ok', data: r.value, error: null })
          else set({ status: 'err', data: null, error: r })
        })
      }
      useState(function () { reload(); return null })

      function runAction(key, action) {
        setBusy(key)
        rpcPost('/addons', { module: key, action: action }).then(function (r) {
          setBusy(null)
          if (!r.ok) {
            set({ status: 'ok', data: s.data, error: { code: r.code, message: (r.message || '操作失败') } })
          }
          reload()
        })
      }

      if (s.status === 'loading') {
        return createElement(Card, { title: '高级功能模块' },
          createElement(Status, { kind: 'loading' }, '检测模块安装状态……'),
        )
      }
      if (s.status === 'err') {
        return createElement(Card, { title: '高级功能模块' },
          createElement(Status, { kind: 'error' }, errTitle(s.error), s.error.code, ' · ', s.error.message || ''),
          createElement('p', { style: styles.note },
            envReadyHint(s.error.code),
            ' · ',
            createElement('button', { onClick: reload, style: { background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', padding: 0 } }, '重试'),
          ),
        )
      }

      var modules = (s.data && s.data.modules) || {}
      var keys = Object.keys(modules)
      return createElement(Card, { title: '高级功能模块（' + keys.length + ' 个）' },
        createElement('div', { style: { fontSize: '0.85em', opacity: 0.7, marginBottom: 10 } },
          '第三层扩展：体积较大或受众窄的能力包，按需安装到插件私有 venv，不影响首装体积。',
        ),
        s.error ? createElement('p', { style: { color: '#d73a49', fontSize: '0.88em' } }, '上次操作失败：', s.error.message || '') : null,
        keys.map(function (key) {
          var m = modules[key]
          var installed = !!m.installed
          var isBusy = busyKey === key
          return createElement('div', {
            key: key,
            style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px dashed currentColor' },
          },
            createElement('div', { style: { flex: 1 } },
              createElement('div', null,
                createElement('span', { style: { fontWeight: 600 } }, m.name),
                createElement('span', { style: { opacity: 0.5, marginLeft: 8, fontSize: '0.85em' } }, m.size || ''),
              ),
              createElement('div', { style: { fontSize: '0.85em', opacity: 0.65 } }, m.description || ''),
              createElement('div', { style: { fontSize: '0.8em', opacity: 0.5, fontFamily: 'ui-monospace, monospace' } },
                (m.packages || []).map(function (p) { return typeof p === 'string' ? p : p.package }).join(' · ')),
            ),
            createElement('div', { style: { whiteSpace: 'nowrap', fontSize: '0.85em' } },
              isBusy
                ? createElement('span', { style: { opacity: 0.7 } }, '⏳ 正在处理……（uv pip，可能几分钟）')
                : installed
                  ? createElement('span', null,
                      createElement('span', { style: { color: '#22863a', marginRight: 8 } }, '✓ 已安装'),
                      createElement('button', {
                        onClick: function () { runAction(key, 'uninstall') },
                        style: { background: 'transparent', border: '1px solid currentColor', borderRadius: 4, color: 'inherit', cursor: 'pointer', padding: '3px 10px', font: 'inherit', opacity: 0.7 },
                      }, '卸载'),
                    )
                  : createElement('button', {
                      onClick: function () { runAction(key, 'install') },
                      style: { background: 'transparent', border: '1px solid currentColor', borderRadius: 4, color: 'inherit', cursor: 'pointer', padding: '3px 10px', font: 'inherit', fontWeight: 600 },
                    }, '一键安装'),
            ),
          )
        }),
        createElement('p', { style: styles.note },
          '安装 = uv pip install 到插件私有 venv（官方源失败自动切清华镜像）；biocrnpyler 自动 --no-deps（fa2-modified 无 Windows wheel）。',
          createElement('button', { onClick: reload, style: { background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', padding: 0, marginLeft: 4 } }, '刷新状态'),
        ),
      )
    }

    function envReadyHint(code) {
      if (code === 'env-not-ready') return '首次调用 bio_python 即会触发引导（下载 uv + Python + 装包可能几分钟）'
      if (code === 'network') return 'RPC 路由未注册或被代理拦截——确认 dsh 实例已加载最新插件（含 src/server.js）'
      return ''
    }

    // ---------------------------------------------------------------- 工具试运行 tab

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
     * 工具试运行视图：选择工具 → 填参数 → 执行 → 查看结果。
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
        return createElement(Card, { title: '工具试运行' }, createElement(Status, null, '加载工具列表……'))
      }
      if (schemas.status === 'err') {
        return createElement(Card, { title: '工具试运行' }, createElement(Status, { kind: 'error' }, '加载失败'))
      }

      var tools = schemas.data || []

      return createElement('div', null,
        // 工具选择下拉
        createElement(Card, { title: '工具试运行（' + tools.length + ' 个工具）' },
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
              '🐍 Python'
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

    // ---------------------------------------------------------------- 代谢建模分页

    /** 人类可读的字节数。 */
    function fmtBytes(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(2) + ' MB'
    }

    /** 时间戳（ISO）→ 'YYYY-MM-DD HH:MM'。 */
    function fmtTime(iso) {
      if (!iso || typeof iso !== 'string') return '—'
      return iso.slice(0, 16).replace('T', ' ')
    }

    function MetabolicRefreshButton(props) {
      return createElement('button', {
        onClick: props.onRefresh,
        disabled: props.loading,
        style: { background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: props.loading ? 'wait' : 'pointer', font: 'inherit', padding: 0, marginLeft: 4 },
      }, props.loading ? '重新探测中…' : '重新探测')
    }

    function remediationOwner(owner) {
      return owner === 'genie' ? '由 genie 修复'
        : owner === 'gem' ? '由 gem 修复'
        : owner === 'graft' ? '由 graft 修复'
        : owner === 'galatea' ? '由 galatea 修复'
        : '需确认责任方'
    }

    /** 代谢建模分页的完整只读状态卡（ready / degraded / legacy 共用）。 */
    function MetabolicDetails(props) {
      var d = props.data || {}
      var legacy = d.state === 'legacy'
      var snapshot = legacy ? d : (d.data || {})
      var env = legacy ? {} : (d.env || {})
      var models = (snapshot.models && snapshot.models.items) || []
      var ledger = snapshot.ledger || { ledgers: [] }
      var exportItems = (snapshot.exports && snapshot.exports.items) || []
      var py = env.python || {}
      var engines = legacy ? (d.engines || {}) : (env.engines || {})
      var sel = py.selected
      var monoBreak = Object.assign({}, styles.pkgName, { wordBreak: 'break-all' })

      return createElement('div', null,
        props.stale
          ? createElement(Card, { title: '状态快照' },
              createElement(Status, { kind: 'warn' }, '上次成功状态，已过期（重新探测失败）。'),
            )
          : null,
        createElement(Card, { title: '域插件：dsh-bio-gem（代谢建模）' },
          createElement('table', { style: styles.kvTable },
            createElement('tbody', null,
              kvRow('状态', createElement(Status, { kind: legacy ? 'warn' : d.state === 'degraded' ? 'warn' : 'ok' },
                legacy ? '旧版只读兼容' : d.state === 'degraded' ? '已安装 · 部分运行时未就绪' : '已安装 · 协议就绪')),
              kvRow('版本', d.version || '—'),
              kvRow('探测方式', d.detectedBy || '—'),
              kvRow('插件目录', createElement('span', { style: { wordBreak: 'break-all' } }, d.pluginDir || '—')),
              legacy ? kvRow('数据根', createElement('span', { style: { wordBreak: 'break-all' } }, d.dataRoot || '—')) : null,
              !legacy ? kvRow('协议', 'host v' + ((d.protocol && d.protocol.hostMajor) || 1) + ' / gem v' + ((d.protocol && d.protocol.gemMajor) || '—')) : null,
              !legacy ? kvRow('生成时间', fmtTime(d.generatedAt)) : null,
            ),
          ),
          legacy
            ? createElement('p', { style: styles.note },
                '旧版兼容视图仅展示文件系统摘要；不提供管理操作。升级到 ≥' + (d.minimumVersion || '0.1.11') + ' 后可获得完整状态面板。')
            : createElement('p', { style: styles.note },
                '本分页由 BioGenie 面板托管；运行时状态由 gem 的只读 integration API 提供。',
                createElement(MetabolicRefreshButton, { onRefresh: props.onRefresh, loading: props.loading }),
            ),
        ),

        !legacy ? createElement(Card, { title: 'Python 环境（gem 工具的解释器）' },
          sel
            ? createElement('table', { style: styles.kvTable },
                createElement('tbody', null,
                  kvRow('选中解释器', createElement('span', { style: { wordBreak: 'break-all' } }, sel.path)),
                  kvRow('来源', sel.source),
                  kvRow('cobra', sel.cobraVersion || '—'),
                ),
              )
            : createElement(Status, { kind: 'error' }, py.note || '未探测到可用解释器'),
          (py.candidates || []).length
            ? createElement('table', { style: styles.pkgTable },
                createElement('thead', null,
                  createElement('tr', null,
                    createElement('th', { style: styles.pkgName }, '候选解释器'),
                    createElement('th', { style: styles.pkgName }, '来源'),
                    createElement('th', { style: styles.pkgVer }, '存在'),
                  ),
                ),
                createElement('tbody', null,
                  py.candidates.map(function (c, i) {
                    return createElement('tr', { key: i, style: styles.pkgRow },
                      createElement('td', { style: monoBreak }, c.path),
                      createElement('td', { style: styles.pkgName }, c.source),
                      createElement('td', { style: styles.pkgVer }, c.exists ? '✓' : '—'),
                    )
                  }),
                ),
              )
            : null,
        ) : null,

        createElement(Card, { title: '模型（' + ((snapshot.models && snapshot.models.count) || 0) + '）' },
          models.length === 0
            ? createElement(Status, { kind: 'warn' }, '暂无模型文件 —— 构建后由 gem 产出。')
            : createElement('table', { style: styles.pkgTable },
                createElement('thead', null,
                  createElement('tr', null,
                    createElement('th', { style: styles.pkgName }, '模型文件'),
                    createElement('th', { style: styles.pkgVer }, '大小'),
                    createElement('th', { style: styles.pkgVer }, '修改时间'),
                  ),
                ),
                createElement('tbody', null,
                  models.map(function (m, i) {
                    return createElement('tr', { key: i, style: styles.pkgRow },
                      createElement('td', { style: monoBreak }, m.name),
                      createElement('td', { style: styles.pkgVer }, fmtBytes(m.sizeBytes)),
                      createElement('td', { style: styles.pkgVer }, fmtTime(m.modifiedAt)),
                    )
                  }),
                ),
              ),
        ),

        createElement(Card, { title: '预测账本（' + (ledger.count || 0) + ' 个模型 / ' + (ledger.totalEntries || 0) + ' 条）' },
          (ledger.ledgers || []).length === 0
            ? createElement(Status, { kind: 'warn' }, '暂无账本条目。')
            : createElement('table', { style: styles.pkgTable },
                createElement('thead', null,
                  createElement('tr', null,
                    createElement('th', { style: styles.pkgName }, '模型'),
                    createElement('th', { style: styles.pkgVer }, '条目'),
                    createElement('th', { style: styles.pkgVer }, '最近更新'),
                  ),
                ),
                createElement('tbody', null,
                  ledger.ledgers.map(function (l, i) {
                    return createElement('tr', { key: i, style: styles.pkgRow },
                      createElement('td', { style: monoBreak }, l.model),
                      createElement('td', { style: styles.pkgVer }, String(l.entries)),
                      createElement('td', { style: styles.pkgVer }, fmtTime(l.modifiedAt)),
                    )
                  }),
                ),
              ),
          ledger.dir ? createElement('p', { style: styles.note }, '账本目录：', ledger.dir) : null,
        ),

        createElement(Card, { title: '导出（' + ((snapshot.exports && snapshot.exports.count) || 0) + '）' },
          exportItems.length === 0
            ? createElement(Status, { kind: 'warn' }, '暂无导出记录。')
            : createElement('table', { style: styles.pkgTable },
                createElement('thead', null,
                  createElement('tr', null,
                    createElement('th', { style: styles.pkgName }, '文件'),
                    createElement('th', { style: styles.pkgVer }, '大小'),
                    createElement('th', { style: styles.pkgVer }, '修改时间'),
                  ),
                ),
                createElement('tbody', null,
                  exportItems.map(function (item, i) {
                    return createElement('tr', { key: i, style: styles.pkgRow },
                      createElement('td', { style: monoBreak }, item.name),
                      createElement('td', { style: styles.pkgVer }, fmtBytes(item.sizeBytes)),
                      createElement('td', { style: styles.pkgVer }, fmtTime(item.modifiedAt)),
                    )
                  }),
                ),
              ),
        ),

        createElement(Card, { title: '构建引擎（gem_build）' },
          createElement('table', { style: styles.kvTable },
            createElement('tbody', null,
              kvRow('CarveMe（快速）',
                engines.carveme && engines.carveme.available
                  ? createElement(Status, { kind: 'ok' }, '可用')
                  : createElement(Status, { kind: 'warn' }, '不可用')),
              kvRow('gapseq（WSL2，质量档）',
                engines.gapseq && engines.gapseq.available
                  ? createElement(Status, { kind: 'ok' }, '可用')
                  : createElement(Status, { kind: 'warn' }, '未就绪')),
            ),
          ),
          engines.carveme && engines.carveme.hint ? createElement('p', { style: styles.note }, engines.carveme.hint) : null,
          engines.gapseq && engines.gapseq.hint ? createElement('p', { style: styles.note }, engines.gapseq.hint) : null,
        ),

        createElement(Card, { title: '工具清单（' + ((d.tools || []).length) + '）' },
          createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, lineHeight: 1.9 } },
            (d.tools || []).map(function (tool) {
              return createElement('code', { key: tool, style: { fontSize: '0.82em', opacity: 0.8 } }, tool)
            }),
          ),
          !legacy && (d.features || []).length
            ? createElement('p', { style: styles.note }, '协议能力：', (d.features || []).join(' · '))
            : null,
        ),
      )
    }

    /** 按五态展示 dsh-bio-gem；not-installed 由父组件直接隐藏 tab。 */
    function MetabolicView(props) {
      var d = props.data || {}
      var state = d.state
      if (!state && props.loading) {
        return createElement(Card, { title: '代谢建模' },
          createElement(Status, { kind: 'loading' }, '正在读取 dsh-bio-gem 状态……'),
        )
      }
      if (state === 'installed-unavailable') {
        return createElement(Card, { title: '代谢建模：dsh-bio-gem' },
          createElement(Status, { kind: 'warn' }, '已安装，但当前不可用。'),
          createElement('p', { style: styles.note }, d.availabilityMessage || '无法读取 gem integration API；这不代表插件未安装。'),
          createElement('table', { style: styles.kvTable },
            createElement('tbody', null,
              kvRow('已发现版本', d.version || '—'),
              kvRow('探测方式', d.detectedBy || '—'),
            ),
          ),
          createElement('p', { style: styles.note }, createElement(MetabolicRefreshButton, { onRefresh: props.onRefresh, loading: props.loading })),
        )
      }
      if (state === 'incompatible') {
        var protocol = d.protocol || {}
        return createElement(Card, { title: '代谢建模：协议不兼容' },
          createElement(Status, { kind: 'error' }, '已安装，但 gem 的集成协议版本不兼容。'),
          createElement('table', { style: styles.kvTable },
            createElement('tbody', null,
              kvRow('BioGenie 协议 major', 'v' + (protocol.hostMajor || 1)),
              kvRow('gem 协议 major', 'v' + (protocol.gemMajor || '—')),
              kvRow('升级目标', 'gem ≥' + (d.minimumVersion || '0.1.11') + '（协议 v1）'),
            ),
          ),
          createElement('p', { style: styles.note }, createElement(MetabolicRefreshButton, { onRefresh: props.onRefresh, loading: props.loading })),
        )
      }
      if (state === 'degraded') {
        var failedChecks = (d.checks || []).filter(function (check) { return check.status !== 'ok' })
        return createElement('div', null,
          createElement(Card, { title: '代谢建模：部分运行时未就绪' },
            createElement(Status, { kind: 'warn' }, '真实状态为 degraded：下列检查未通过。'),
            createElement('ul', { style: { margin: '8px 0 0', paddingLeft: 20 } },
              failedChecks.map(function (check) {
                return createElement('li', { key: check.id },
                  createElement('code', null, check.id), ' · ', check.status, check.detail ? ' · ' + check.detail : '')
              }),
            ),
            (d.remediations || []).length
              ? createElement('ul', { style: { margin: '8px 0 0', paddingLeft: 20 } },
                  d.remediations.map(function (remediation) {
                    return createElement('li', { key: remediation.code },
                      createElement('code', null, remediation.code), ' — ', remediationOwner(remediation.owner),
                      remediation.detail ? '：' + remediation.detail : '')
                  }),
                )
              : null,
            createElement('p', { style: styles.note }, createElement(MetabolicRefreshButton, { onRefresh: props.onRefresh, loading: props.loading })),
          ),
          createElement(MetabolicDetails, props),
        )
      }
      if (state === 'legacy') {
        return createElement('div', null,
          createElement(Card, { title: '代谢建模：旧版兼容视图' },
            createElement(Status, { kind: 'warn' }, '旧版兼容视图（gem ' + (d.version || '—') + '）——仅只读摘要，升级到 ≥' + (d.minimumVersion || '0.1.11') + ' 获得完整面板。'),
            createElement('p', { style: styles.note }, '该兼容页不能执行管理操作。'),
          ),
          createElement(MetabolicDetails, props),
        )
      }
      if (state === 'ready') return createElement(MetabolicDetails, props)
      return createElement(Card, { title: '代谢建模' },
        createElement(Status, { kind: 'loading' }, '等待状态探测……'),
      )
    }

    // ---------------------------------------------------------------- 总览 tab

    function OverviewTab() {
      return createElement('div', null,
        createElement(MetaCard, null),
        createElement(ConfigCard, null),
        createElement(DocsCard, null),
      )
    }

    /** 四域只读聚合视图；能力数字只显示服务端已核实的操作切片。 */
    function DomainOverviewView(props) {
      var data = props.data || {}
      var domains = Array.isArray(data.domains) ? data.domains : []
      var activeTabs = props.activeTabs || []
      var domainStateLabels = {
        host: '宿主运行中', ready: '就绪', degraded: '部分就绪', legacy: '旧版兼容',
        incompatible: '协议不兼容', 'installed-unavailable': '已安装但暂不可读取',
        'not-installed': '未安装',
      }
      var healthLabels = {
        self: '宿主运行中（无独立 integration health）',
        'not-requested': '未探测', reachable: '可达',
        unreachable: '不可达', incompatible: '协议不兼容',
      }
      var operationLabels = {
        available: '可用', probing: '探测中', missing: '缺依赖',
        unknown: '粒度不足/待确认',
      }

      return createElement('div', null,
        createElement(Card, { title: '域总览' },
          createElement('p', { style: styles.note },
            'G 系列插件保持独立安装与发布；此处只读汇总当前实例的安装和运行时状态。'),
          createElement('button', {
            type: 'button', onClick: props.onRefresh, disabled: !!props.loading,
            style: { padding: '5px 14px', font: 'inherit', cursor: props.loading ? 'wait' : 'pointer' },
          }, props.loading ? '正在重新探测…' : '重新探测'),
        ),
        props.error ? createElement(Card, { title: props.data ? '状态快照' : '域总览暂不可用' },
          createElement(Status, { kind: 'error' },
            props.data ? '刷新失败，以下为上次成功快照。' : '无法读取域总览，请重新探测。'),
          createElement('p', { style: styles.note }, props.error.message || props.error.code || '请求失败'),
        ) : null,
        props.loading && !props.data
          ? createElement(Status, { kind: 'loading' }, '正在读取各域状态……')
          : null,
        !props.loading && !props.error && !props.data
          ? createElement(Status, { kind: 'loading' }, '打开域总览后开始探测。')
          : null,
        domains.length ? createElement('div', {
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 12 },
        }, domains.map(function (card) {
          var installed = card.installed === true
          var health = card.health || {}
          var availability = card.availability || {}
          var counts = availability.counts || {}
          var operations = Array.isArray(availability.operations) ? availability.operations : []
          var assets = Array.isArray(card.assets) ? card.assets : []
          var remediations = Array.isArray(card.remediations) ? card.remediations : []
          var hasPartialCounts = installed && availability.coverage === 'partial'
            && typeof counts.available === 'number'
            && typeof counts.probing === 'number'
            && typeof counts.missing === 'number'
          var healthText = installed
            ? (healthLabels[health.state] || '状态未知')
            : '未探测（未安装）'
          var stateText = installed
            ? (domainStateLabels[card.state] || '已安装 · 状态未知')
            : '未安装'
          return createElement(Card, { key: card.id, title: card.label || card.packageName || card.id },
            createElement('table', { style: styles.kvTable },
              createElement('tbody', null,
                kvRow('插件', card.packageName || card.id || '—'),
                kvRow('安装', installed ? '已安装' : '未安装'),
                kvRow('版本', installed ? (card.version || '—') : '—'),
                kvRow('域状态', stateText),
                kvRow('integration health', healthText),
                kvRow('能力计数', hasPartialCounts
                  ? '可用 ' + counts.available + ' / 探测中 ' + counts.probing
                    + ' / 缺依赖 ' + counts.missing
                  : '不可得 · 粒度不足'),
              ),
            ),
            hasPartialCounts ? createElement('p', { style: styles.note },
              '仅已核实操作，非全域总数；其余粒度不足。') : null,
            !installed ? createElement('p', { style: styles.note },
              '域插件未安装；integration 未探测；能力计数不可得。') : null,
            availability.reason ? createElement('p', { style: styles.note }, availability.reason) : null,
            operations.length ? createElement('ul', { style: { margin: '8px 0', paddingLeft: 20, fontSize: '0.88em' } },
              operations.map(function (operation, index) {
                var selector = operation.selector || {}
                var selectorText = Object.keys(selector).map(function (key) {
                  return key + '=' + selector[key]
                }).join(', ')
                var missing = Array.isArray(operation.missingDependencies)
                  ? operation.missingDependencies : []
                return createElement('li', { key: (operation.tool || 'operation') + ':' + index },
                  createElement('code', null, operation.tool || '未知操作'),
                  selectorText ? ' (' + selectorText + ')' : '',
                  ' · ' + (operationLabels[operation.state] || '粒度不足/待确认'),
                  missing.length ? ' · 缺少 ' + missing.join('、') : '',
                )
              }),
            ) : null,
            remediations.length ? createElement('p', { style: styles.note },
              '修复提示：' + remediations.map(function (item) {
                return item.detail || item.message || item.code || String(item)
              }).join('；')) : null,
            installed && card.id !== 'genie' && assets.length && activeTabs.indexOf(assets[0].tab) !== -1
              ? createElement('button', {
                  type: 'button',
                  onClick: function () { props.onOpenTab(assets[0].tab) },
                  style: { font: 'inherit', fontSize: '0.9em', cursor: 'pointer', marginBottom: 8 },
                }, '查看域详情与修复建议') : null,
            assets.length ? createElement('div', { style: styles.linkRow },
              assets.map(function (asset, index) {
                var tabReady = installed && activeTabs.indexOf(asset.tab) !== -1
                var label = asset.label || '查看资产'
                if (typeof asset.count === 'number') label += '（' + asset.count + '）'
                return createElement('button', {
                  key: (asset.tab || 'asset') + ':' + index,
                  type: 'button', disabled: !tabReady,
                  onClick: function () { if (tabReady) props.onOpenTab(asset.tab) },
                  style: { font: 'inherit', fontSize: '0.9em', cursor: tabReady ? 'pointer' : 'default' },
                }, label)
              }),
            ) : null,
          )
        })) : null,
      )
    }

    /** 基因编辑设计分页的只读状态卡（ready / degraded / legacy 共用）。 */
    function EditingDetails(props) {
      var d = props.data || {}
      var legacy = d.state === 'legacy'
      var snapshot = legacy ? d : (d.data || {})
      var env = legacy ? {} : (d.env || {})
      var plans = (snapshot.plans && snapshot.plans.items) || []
      var editors = snapshot.editors || []
      var backend = (snapshot.backend && snapshot.backend.casOffinder) || {}
      var interp = env.interpreter || {}
      var sel = interp.selected

      return createElement('div', null,
        props.stale
          ? createElement(Card, { title: '状态快照' },
              createElement(Status, { kind: 'warn' }, '上次成功状态，已过期（重新探测失败）。'),
            )
          : null,
        createElement(Card, { title: '域插件：dsh-bio-graft（基因编辑设计）' },
          createElement('table', { style: styles.kvTable },
            createElement('tbody', null,
              kvRow('状态', createElement(Status, { kind: legacy || d.state === 'degraded' ? 'warn' : 'ok' },
                legacy ? '旧版只读兼容' : d.state === 'degraded' ? '已安装 · 部分运行时未就绪' : '已安装 · 协议就绪')),
              kvRow('版本', d.version || '—'),
              kvRow('探测方式', d.detectedBy || '—'),
              kvRow('插件目录', createElement('span', { style: { wordBreak: 'break-all' } }, d.pluginDir || '—')),
              legacy ? kvRow('数据根', createElement('span', { style: { wordBreak: 'break-all' } }, d.dataRoot || '—')) : null,
              !legacy ? kvRow('协议', 'host v' + ((d.protocol && d.protocol.hostMajor) || 1) + ' / graft v' + ((d.protocol && d.protocol.graftMajor) || '—')) : null,
              !legacy ? kvRow('生成时间', fmtTime(d.generatedAt)) : null,
              !legacy ? kvRow('语义化工具', (d.tools || []).length + ' 个 graft_*') : null,
            ),
          ),
          legacy
            ? createElement('p', { style: styles.note },
                '旧版兼容视图仅展示文件系统摘要；不提供管理操作。升级到 ≥' + (d.minimumVersion || '0.1.1') + ' 后可获得完整状态面板。')
            : createElement('p', { style: styles.note },
                '本分页由 BioGenie 面板托管；运行时状态由 graft 的只读 integration API 提供。',
                createElement(MetabolicRefreshButton, { onRefresh: props.onRefresh, loading: props.loading }),
            ),
        ),

        !legacy ? createElement(Card, { title: '脱靶扫描后端（Cas-OFFinder）' },
          createElement('table', { style: styles.kvTable },
            createElement('tbody', null,
              kvRow('可执行文件', backend.present
                ? createElement(Status, { kind: 'ok' }, '已就绪')
                : createElement(Status, { kind: 'warn' }, '未安装')),
              kvRow('路径', createElement('span', { style: { wordBreak: 'break-all' } }, backend.path || '—')),
            ),
          ),
          backend.present
            ? createElement('p', { style: styles.note }, '扫描时 device 默认 auto：无 CPU OpenCL 设备会自动改用 GPU 并回显实际设备与理由。')
            : createElement('p', { style: styles.note }, 'agent 调 graft_backend_status(action="ensure") 自动获取官方 BSD-3 二进制（仅 Windows）。'),
        ) : null,

        !legacy ? createElement(Card, { title: 'Python 环境（graft 工具的解释器）' },
          sel
            ? createElement('table', { style: styles.kvTable },
                createElement('tbody', null,
                  // 注意：graft 的 status 里 env.interpreter.selected 是**路径字符串**
                  // （不是对象）；早期版本误按 sel.path 读会渲染成「—」（真实渲染实测抓到）。
                  kvRow('选中解释器', createElement('span', { style: { wordBreak: 'break-all' } },
                    typeof sel === 'string' ? sel : (sel.path || '—'))),
                  kvRow('来源', interp.source || '—'),
                ),
              )
            : createElement(Status, { kind: 'error' }, '未探测到可用解释器（graft 的 op 全部为标准库实现，PATH python 亦可）'),
        ) : null,

        !legacy ? createElement(Card, { title: '编辑器注册表（' + editors.length + ' 个 profile）' },
          editors.length
            ? createElement('table', { style: styles.pkgTable },
                createElement('thead', null,
                  createElement('tr', null,
                    createElement('th', { style: styles.pkgName }, '编辑器'),
                    createElement('th', { style: styles.pkgName }, 'PAM'),
                    createElement('th', { style: styles.pkgName }, 'spacer'),
                    createElement('th', { style: styles.pkgName }, '证据分级'),
                  ),
                ),
                createElement('tbody', null, editors.map(function (e) {
                  return createElement('tr', { key: e.name },
                    createElement('td', { style: styles.pkgName }, e.name),
                    createElement('td', { style: styles.pkgName }, (e.pam || '—') + (e.pamSide === '5prime' ? ' (5′)' : ' (3′)')),
                    createElement('td', { style: styles.pkgName }, String(e.spacerLength || '—') + ' nt'),
                    createElement('td', { style: styles.pkgName }, e.verified
                      ? createElement(Status, { kind: 'ok' }, '已核文献')
                      : createElement(Status, { kind: 'warn' }, '未核（禁止当既定事实）')),
                  )
                })),
              )
            : createElement(Status, { kind: 'warn' }, '注册表为空'),
        ) : null,

        !legacy ? createElement(Card, { title: 'EditPlan 账本（' + ((snapshot.plans && snapshot.plans.count) || 0) + ' 个计划）' },
          plans.length
            ? createElement('table', { style: styles.pkgTable },
                createElement('thead', null,
                  createElement('tr', null,
                    createElement('th', { style: styles.pkgName }, '计划'),
                    createElement('th', { style: styles.pkgVer }, '大小'),
                    createElement('th', { style: styles.pkgVer }, '更新'),
                  ),
                ),
                createElement('tbody', null, plans.map(function (p) {
                  return createElement('tr', { key: p.name },
                    createElement('td', { style: styles.pkgName }, p.name),
                    createElement('td', { style: styles.pkgVer }, Math.max(1, Math.round((p.sizeBytes || 0) / 1024)) + ' KB'),
                    createElement('td', { style: styles.pkgVer }, fmtTime(p.modifiedAt)),
                  )
                })),
              )
            : createElement(Status, { kind: 'warn' }, '暂无计划 —— agent 用 graft_plan_save 创建'),
          createElement('p', { style: styles.note }, '计划目录：' + ((snapshot.plans && snapshot.plans.dir) || '—')),
        ) : null,

        !legacy ? createElement(Card, { title: '修复责任方' },
          (d.remediations || []).length
            ? createElement('table', { style: styles.pkgTable },
                createElement('thead', null,
                  createElement('tr', null,
                    createElement('th', { style: styles.pkgVer }, 'code'),
                    createElement('th', { style: styles.pkgName }, '责任方'),
                    createElement('th', { style: styles.pkgName }, '详情'),
                  ),
                ),
                createElement('tbody', null, (d.remediations || []).map(function (r, i) {
                  return createElement('tr', { key: i },
                    createElement('td', { style: styles.pkgVer }, r.code),
                    createElement('td', { style: styles.pkgName }, remediationOwner(r.owner)),
                    createElement('td', { style: styles.pkgName }, r.detail || ''),
                  )
                })),
              )
            : createElement(Status, { kind: 'ok' }, '无需修复项'),
        ) : null,
      )
    }

    /** 基因编辑设计分页入口：处理 loading / installed-unavailable / incompatible，其余交给详情卡。 */
    function EditingView(props) {
      var d = props.data || {}
      var state = d.state
      if (!state && props.loading) {
        return createElement(Card, { title: '基因编辑设计' },
          createElement(Status, { kind: 'loading' }, '正在读取 dsh-bio-graft 状态……'),
        )
      }
      if (state === 'installed-unavailable') {
        return createElement(Card, { title: '基因编辑设计：dsh-bio-graft' },
          createElement(Status, { kind: 'warn' }, '已安装，但当前不可用。'),
          createElement('p', { style: styles.note }, d.availabilityMessage || '无法读取 graft integration API；这不代表插件未安装。'),
          createElement('p', { style: styles.note }, createElement(MetabolicRefreshButton, { onRefresh: props.onRefresh, loading: props.loading })),
        )
      }
      if (state === 'incompatible') {
        var protocol = d.protocol || {}
        return createElement(Card, { title: '基因编辑设计：dsh-bio-graft' },
          createElement(Status, { kind: 'warn' }, '协议版本不匹配，无法读取运行时状态。'),
          createElement('table', { style: styles.kvTable },
            createElement('tbody', null,
              kvRow('宿主协议', 'v' + (protocol.hostMajor || 1)),
              kvRow('graft 协议', 'v' + (protocol.graftMajor || '—')),
              kvRow('建议', '升级 dsh-bio-graft 到 ≥' + (d.minimumVersion || '0.1.1')),
            ),
          ),
        )
      }
      return EditingDetails(props)
    }

    /** 蛋白设计分页入口：处理 loading / installed-unavailable / incompatible，其余交给详情卡。 */
    function GalateaView(props) {
      var d = props.data || {}
      var state = d.state
      if (!state && props.loading) {
        return createElement(Card, { title: '蛋白设计' },
          createElement(Status, { kind: 'loading' }, '正在读取 dsh-bio-galatea 状态……'),
        )
      }
      if (state === 'installed-unavailable') {
        return createElement(Card, { title: '蛋白设计：dsh-bio-galatea' },
          createElement(Status, { kind: 'warn' }, '已安装，但当前不可用。'),
          createElement('p', { style: styles.note }, d.availabilityMessage || '无法读取 galatea integration API；这不代表插件未安装。'),
          createElement('p', { style: styles.note }, createElement(MetabolicRefreshButton, { onRefresh: props.onRefresh, loading: props.loading })),
        )
      }
      if (state === 'incompatible') {
        var protocol = d.protocol || {}
        return createElement(Card, { title: '蛋白设计：dsh-bio-galatea' },
          createElement(Status, { kind: 'warn' }, '协议版本不匹配，无法读取运行时状态。'),
          createElement('table', { style: styles.kvTable },
            createElement('tbody', null,
              kvRow('宿主协议', 'v' + (protocol.hostMajor || 1)),
              kvRow('galatea 协议', 'v' + (protocol.galateaMajor || '—')),
              kvRow('建议', '升级 dsh-bio-galatea 到 ≥' + (d.minimumVersion || '0.1.1')),
            ),
          ),
        )
      }
      return GalateaDetails(props)
    }

    /** galatea 详情：检查项 + 模型目录管理（可安装到其他磁盘）+ 重探测。 */
    function GalateaDetails(props) {
      var d = props.data || {}
      var checks = d.checks || []
      return createElement('div', null,
        createElement(Card, { title: '蛋白设计：dsh-bio-galatea' },
          createElement('p', { style: styles.note },
            '运行时版本 ' + (d.version || '—') + '（安装版 ' + (d.installVersion || '—') + '）；'
            + ((d.tools || []).length) + ' 个语义化工具（G 系列：结构预测 / 序列设计 / 界面分析）。',
          ),
          createElement(GalateaModelsCard, null),
          createElement('p', { style: styles.note },
            createElement(MetabolicRefreshButton, { onRefresh: props.onRefresh, loading: props.loading }),
          ),
          checks.length ? createElement('table', { style: styles.kvTable },
            createElement('tbody', null, checks.map(function (check) {
              return kvRow(check.id, (check.status === 'ok' ? '✅ 正常' : '⚠️ ' + check.status) + (check.detail ? ' — ' + check.detail : ''))
            })),
          ) : null,
        ),
      )
    }

    /** galatea 模型目录管理卡：显示/更改模型安装位置（写 config.json 的 modelsDir）。 */
    function GalateaModelsCard() {
      var stateS = useState({ status: 'loading', data: null, error: null })
      var state = stateS[0], setState = stateS[1]
      var inputS = useState('')
      var input = inputS[0], setInput = inputS[1]
      var busyS = useState(false)
      var busy = busyS[0], setBusy = busyS[1]
      var messageS = useState(null)
      var message = messageS[0], setMessage = messageS[1]

      function reload() {
        rpc('/galatea-models').then(function (r) {
          if (r.ok) setState({ status: 'ready', data: r.value, error: null })
          else setState({ status: 'error', data: null, error: r })
        })
      }
      useState(function () { reload(); return null })

      function apply(target) {
        var value = typeof target === 'string' ? target.trim() : (input || '').trim()
        setBusy(true)
        setMessage(null)
        rpcPost('/galatea-models', { modelsDir: value }).then(function (r) {
          setBusy(false)
          if (r.ok) {
            setState({ status: 'ready', data: r.value, error: null })
            if (r.value.source === 'env') {
              setMessage({ text: '已写入配置，但当前仍被环境变量 GALATEA_MODELS_DIR 覆盖（' + r.value.dir + '）——移除该变量后生效。' })
            } else if (value === '') {
              setMessage({ text: '已恢复默认位置：' + r.value.dir })
            } else {
              setMessage({ text: '已保存并生效：' + r.value.dir + '（galatea 下一次工具调用即按新位置解析；面板状态最长 60 秒后刷新）' })
            }
          } else {
            setMessage({ text: r.message || '保存失败' })
          }
        })
      }

      function fmtBytes(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '—'
        if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
        if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
        return String(n) + ' B'
      }

      var d = state.data || {}
      var listing = d.listing || {}
      var sourceLabel = d.source === 'env' ? '环境变量覆盖（GALATEA_MODELS_DIR）'
        : d.source === 'config' ? '自定义（config.json）'
        : '默认位置'
      var btnStyle = { padding: '5px 14px', cursor: busy ? 'wait' : 'pointer', font: 'inherit', fontSize: '0.9em' }

      if (state.status === 'loading') {
        return createElement(Card, { title: '模型目录（可安装到其他磁盘）' },
          createElement(Status, { kind: 'loading' }, '正在读取模型目录……'),
        )
      }
      if (state.status === 'error') {
        return createElement(Card, { title: '模型目录（可安装到其他磁盘）' },
          createElement(Status, { kind: 'warn' }, '无法读取模型目录状态：' + ((state.error && state.error.message) || 'unknown')),
        )
      }
      return createElement(Card, { title: '模型目录（可安装到其他磁盘）' },
        createElement('table', { style: styles.kvTable },
          createElement('tbody', null,
            kvRow('当前目录', d.dir || '—'),
            kvRow('来源', sourceLabel),
            kvRow('占用', (listing.fileCount || 0) + ' 个文件 / ' + fmtBytes(listing.sizeBytes || 0)),
            kvRow('组件', (listing.components || []).map(function (c) {
              return c.component + '：' + c.fileCount + ' 文件 / ' + fmtBytes(c.sizeBytes || 0)
            }).join('；') || '（无）'),
          ),
        ),
        createElement('p', { style: styles.note },
          'ESMFold 权重约 2.5GB、MPNN 权重数百 MB——放到其他磁盘可显著节省 C 盘空间。'
          + '指向已含 esmfold/ 与 mpnn/ 的目录（如现有模型库）会直接复用其中权重；'
          + '指向空目录则下次 galatea_setup 会把模型下载到新位置。',
        ),
        createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' } },
          createElement('input', {
            type: 'text',
            value: input,
            placeholder: '目标目录绝对路径，例如 F:/Models/AI_models',
            onChange: function (e) { setInput(e.target.value) },
            style: { flex: '1 1 320px', padding: '6px 8px', fontFamily: 'inherit', fontSize: '0.9em' },
          }),
          createElement('button', { onClick: function () { apply() }, disabled: busy, style: btnStyle }, busy ? '保存中…' : '保存并应用'),
          createElement('button', {
            onClick: function () { setInput(''); apply('') },
            disabled: busy,
            style: btnStyle,
          }, '恢复默认'),
        ),
        message ? createElement('p', { style: styles.note }, message.text) : null,
      )
    }

    // ---------------------------------------------------------------- 容器

    /**
     * 设置面板内容区。owner props 为 { close }；当前未使用。
     * 内部维护固定 tab 及按安装状态显示的域分页。
     */
    function BioGenieSection() {
      var tabState = useState('overview')
      var tab = tabState[0], setTab = tabState[1]

      var overviewState = useState({ data: null, loading: false, error: null })
      var domainOverview = overviewState[0], setDomainOverview = overviewState[1]

      function refreshDomainOverview() {
        if (domainOverview.loading) return
        var previous = domainOverview.data
        setDomainOverview({ data: previous, loading: true, error: null })
        rpc('/domain-overview').then(function (result) {
          if (result.ok && result.value && Array.isArray(result.value.domains)) {
            setDomainOverview({ data: result.value, loading: false, error: null })
          } else {
            var error = result.ok
              ? { code: 'bad-shape', message: '域总览响应缺少 domains 列表' }
              : result
            setDomainOverview({ data: previous, loading: false, error: error })
          }
        })
      }

      // 挂载时仅做本地安装探测，避免未打开子页就触发 gem 的健康/环境探测。
      // health/status 只在用户打开「代谢建模」或手动重新探测时请求。
      var gemState = useState({ data: null, lastSuccess: null, loading: false, stale: false, error: null })
      var gem = gemState[0], setGem = gemState[1]
      useState(function () {
        rpc('/metabolic?probe=install').then(function (r) {
          if (r.ok) setGem({ data: r.value, lastSuccess: null, loading: false, stale: false, error: null })
        })
        return null
      })

      // 基因编辑域（dsh-bio-graft）：同样是「挂载时只做本地安装探测」——
      // health/status 只在用户打开「基因编辑设计」或手动重新探测时请求。
      var graftState = useState({ data: null, lastSuccess: null, loading: false, stale: false, error: null })
      var graft = graftState[0], setGraft = graftState[1]
      useState(function () {
        rpc('/editing?probe=install').then(function (r) {
          if (r.ok) setGraft({ data: r.value, lastSuccess: null, loading: false, stale: false, error: null })
        })
        return null
      })

      // 蛋白设计域（dsh-bio-galatea）：同样「挂载时只做本地安装探测」——
      // health/status 只在用户打开「蛋白设计」或手动重新探测时请求。
      var galateaState = useState({ data: null, lastSuccess: null, loading: false, stale: false, error: null })
      var galatea = galateaState[0], setGalatea = galateaState[1]
      useState(function () {
        rpc('/protein?probe=install').then(function (r) {
          if (r.ok) setGalatea({ data: r.value, lastSuccess: null, loading: false, stale: false, error: null })
        })
        return null
      })

      function refreshGem() {
        var previous = gem.lastSuccess || (gem.data && gem.data.state ? gem.data : null)
        setGem({ data: previous || gem.data, lastSuccess: previous, loading: true, stale: false, error: null })
        rpc('/metabolic').then(function (r) {
          if (r.ok) {
            setGem({ data: r.value, lastSuccess: r.value, loading: false, stale: false, error: null })
            return
          }
          if (previous) {
            setGem({ data: previous, lastSuccess: previous, loading: false, stale: true, error: r })
            return
          }
          setGem({
            data: {
              installed: true,
              state: 'installed-unavailable',
              version: gem.data && gem.data.version,
              detectedBy: gem.data && gem.data.detectedBy,
              availabilityMessage: '无法读取 gem integration API；这不代表插件未安装。',
            },
            lastSuccess: null,
            loading: false,
            stale: false,
            error: r,
          })
        })
      }

      function refreshGraft() {
        var previous = graft.lastSuccess || (graft.data && graft.data.state ? graft.data : null)
        setGraft({ data: previous || graft.data, lastSuccess: previous, loading: true, stale: false, error: null })
        rpc('/editing').then(function (r) {
          if (r.ok) {
            setGraft({ data: r.value, lastSuccess: r.value, loading: false, stale: false, error: null })
            return
          }
          if (previous) {
            setGraft({ data: previous, lastSuccess: previous, loading: false, stale: true, error: r })
            return
          }
          setGraft({
            data: {
              installed: true,
              state: 'installed-unavailable',
              version: graft.data && graft.data.version,
              detectedBy: graft.data && graft.data.detectedBy,
              availabilityMessage: '无法读取 graft integration API；这不代表插件未安装。',
            },
            lastSuccess: null,
            loading: false,
            stale: false,
            error: r,
          })
        })
      }

      function refreshGalatea() {
        var previous = galatea.lastSuccess || (galatea.data && galatea.data.state ? galatea.data : null)
        setGalatea({ data: previous || galatea.data, lastSuccess: previous, loading: true, stale: false, error: null })
        rpc('/protein').then(function (r) {
          if (r.ok) {
            setGalatea({ data: r.value, lastSuccess: r.value, loading: false, stale: false, error: null })
            return
          }
          if (previous) {
            setGalatea({ data: previous, lastSuccess: previous, loading: false, stale: true, error: r })
            return
          }
          setGalatea({
            data: {
              installed: true,
              state: 'installed-unavailable',
              version: galatea.data && galatea.data.version,
              detectedBy: galatea.data && galatea.data.detectedBy,
              availabilityMessage: '无法读取 galatea integration API；这不代表插件未安装。',
            },
            lastSuccess: null,
            loading: false,
            stale: false,
            error: r,
          })
        })
      }

      function selectTab(key) {
        setTab(key)
        if (key === 'domains' && !domainOverview.data && !domainOverview.loading && !domainOverview.error) refreshDomainOverview()
        if (key === 'metabolic' && gem.data && gem.data.installed && !gem.loading && !gem.lastSuccess) refreshGem()
        if (key === 'editing' && graft.data && graft.data.installed && !graft.loading && !graft.lastSuccess) refreshGraft()
        if (key === 'protein' && galatea.data && galatea.data.installed && !galatea.loading && !galatea.lastSuccess) refreshGalatea()
      }

      var gemInstalled = !!(gem.data && gem.data.installed)

      var tabs = [
            { key: 'overview', label: '总览' },
            { key: 'domains',  label: '域总览' },
            { key: 'skills',   label: 'Skill 模块' },
            { key: 'debug',    label: '工具试运行' },
            { key: 'python',   label: 'Python 环境' },
            { key: 'addons',   label: '高级模块' },
          ]
      // 「代谢建模」是域插件 dsh-bio-gem 的分页：仅在它已安装时挂载。
      // 未安装时该分页完全不出现（宿主不展示空壳 UI）。
      if (gemInstalled) tabs.push({ key: 'metabolic', label: '代谢建模' })

      // 「基因编辑设计」是域插件 dsh-bio-graft 的分页：仅在它已安装时挂载
      // （未安装时该分页完全不出现——宿主不展示空壳 UI）。
      var graftInstalled = !!(graft.data && graft.data.installed)
      if (graftInstalled) tabs.push({ key: 'editing', label: '基因编辑设计' })

      // 「蛋白设计」是域插件 dsh-bio-galatea 的分页：仅在它已安装时挂载
      // （未安装时该分页完全不出现——宿主不展示空壳 UI）。
      var galateaInstalled = !!(galatea.data && galatea.data.installed)
      if (galateaInstalled) tabs.push({ key: 'protein', label: '蛋白设计' })

      return createElement('div', { className: 'biogenie-settings', style: styles.section },
        createElement('h2', { className: 'biogenie-settings-title', style: styles.h2 }, 'BioGenie 设置'),
        createElement('p', { className: 'biogenie-settings-lead', style: styles.lead },
          '生物信息学「许愿式分析」插件 — bio_python 执行器（Biopython 全覆盖）、',
          '62 个工具（57 语义化 + 5 执行器/元工具）、50 个 skill、零依赖自举 Python 环境。',
        ),
        createElement('div', { role: 'tablist', style: styles.tabBar },
          tabs.map(function (t) {
            var active = t.key === tab
            return createElement('button', {
              key: t.key,
              role: 'tab',
              'aria-selected': active,
              onClick: function () { selectTab(t.key) },
              style: styles.tab(active),
            }, t.label)
          }),
        ),
        tab === 'overview' ? createElement(OverviewTab, null)
                  : tab === 'domains' ? createElement(DomainOverviewView, {
                      data: domainOverview.data,
                      loading: domainOverview.loading,
                      error: domainOverview.error,
                      onRefresh: refreshDomainOverview,
                      onOpenTab: selectTab,
                      activeTabs: tabs.map(function (item) { return item.key }),
                    })
                  : tab === 'skills' ? createElement(SkillsView, null)
                  : tab === 'debug'  ? createElement(ToolDebugView, null)
                  : tab === 'python' ? createElement(PythonView, null)
                  : tab === 'addons' ? createElement(AddonsView, null)
                  : (tab === 'metabolic' && gemInstalled) ? createElement(MetabolicView, {
                      data: gem.data,
                      loading: gem.loading,
                      stale: gem.stale,
                      onRefresh: refreshGem,
                    })
                  : (tab === 'editing' && graftInstalled) ? createElement(EditingView, {
                      data: graft.data,
                      loading: graft.loading,
                      stale: graft.stale,
                      onRefresh: refreshGraft,
                    })
                  : (tab === 'protein' && galateaInstalled) ? createElement(GalateaView, {
                      data: galatea.data,
                      loading: galatea.loading,
                      stale: galatea.stale,
                      onRefresh: refreshGalatea,
                    })
                  : null,
      )
    }

    /**
     * 浏览器端插件入口：注册设置面板侧栏一级菜单「BioGenie」。
     */
    // R2-0: installed-runtime 0.2.0-rc.2 capability adapter; no build step.
    function installFigureHello(ctx) {
      // Explicit developer probe only; ordinary sessions retain the settings UI.
      if (!window.location || new URL(window.location.href).searchParams.get('figviewHello') !== '1') return
      var required = { slots: ['inject', 'register'], uiConversation: [],
        sidebarRight: ['openResource'], sidebarRightTabs: ['register'], resources: ['register'] }
      Object.keys(required).forEach(function (key) {
        if (!ctx[key] || required[key].some(function (method) { return typeof ctx[key][method] !== 'function' })) {
          throw new Error('fig-viewer requires desktop/web 0.2.0 services: ' + key)
        }
      })
      var address = 'dsh-resource://bio-figure/session/figview-r2-hello/hello'
      function HelloCard(props) {
        if (props.sessionId !== 'figview-r2-hello') return null
        return createElement('div', {
          'data-figview-hello': 'turn-tail', 'data-turn': props.turn,
          style: { border: '1px solid currentColor', padding: 12, borderRadius: 6 }
        }, createElement('strong', null, 'fig-viewer hello'),
          createElement('p', null, 'R2-0 isolated loading probe'),
          createElement('button', { type: 'button', onClick: function () { ctx.sidebarRight.openResource(address) } }, 'Open Figure'))
      }
      function FigureBody(props) {
        var info = props.useTabInfo()
        var frame = props.useResource(info.tab.contentId)
        return createElement('section', { 'data-figview-hello': 'figure-tab', style: { padding: 16 } },
          createElement('h2', null, 'Figure hello'),
          createElement('p', null, 'Resource provider: ' + frame.status),
          createElement('pre', { 'data-figview-frame': frame.status }, JSON.stringify(frame.value || null, null, 2)))
      }
      ctx.resources.register({ protocol: 'bio-figure', async *open(resourceAddress, options) {
        if (options.signal.aborted) return
        if (resourceAddress !== address) {
          yield { ok: false, error: { code: 'figview/hello-only', message: 'R2-0 only serves the explicit hello fixture.' } }
          return
        }
        yield { ok: true, value: { schema_version: 1, figure_id: 'hello', revision: 'r2-0-fixture',
          resource_address: resourceAddress, rows: [{ row_id: 'r1', x: 1, y: 2 }, { row_id: 'r2', x: 2, y: 3 }, { row_id: 'r3', x: 3, y: 5 }],
          fixture: true } }
      } })
      ctx.sidebarRightTabs.register({ id: 'bio-figure-viewer', kind: 'bio-figure',
        patterns: ['dsh-resource://bio-figure/**'], canOpen: function (candidate) { return candidate === address },
        title: function () { return 'Figure' } })
      ctx.slots.inject('conversation.chat.turnTail', function () {
        return ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'bio-figure-hello', order: 50 }, HelloCard)
      })
      ctx.slots.inject('sidebar.right.pane.tab', function () {
        return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'bio-figure-viewer' }, FigureBody)
      })
    }

    // ── R2-2：生产版 fig-viewer（真实数据链路）────────────────────────────────
    // 数据流：工具结果(viewer_manifest / 图片路径) → Turn 数据(bio-figures) →
    // turnTail 缩略卡 → sidebarRight.openResource(bio-figure 地址) → provider
    // 读取 manifest/rows/hits 并按内嵌 sha256 逐文件校验 → pane.tab 基础查看器。
    // 完整画布交互（放大 / 命中反查 / 重绘）属 R2-3。
    function installFigureViewer(ctx) {
      // 服务探测：任何一项缺失即静默降级（不得影响设置面板等既有功能）。
      var servicesOk = typeof ctx.slots === 'object' && typeof ctx.slots.register === 'function'
        && typeof ctx.uiConversation === 'object' && ctx.uiConversation.events && typeof ctx.uiConversation.events.register === 'function'
        && typeof ctx.sidebarRight === 'object' && typeof ctx.sidebarRight.openResource === 'function'
        && typeof ctx.sidebarRightTabs === 'object' && typeof ctx.sidebarRightTabs.register === 'function'
        && typeof ctx.resources === 'object' && typeof ctx.resources.register === 'function'
        && typeof ctx.remote === 'object' && ctx.remote.workspaceFiles && typeof ctx.remote.workspaceFiles.readBytes === 'function'
      if (!servicesOk) {
        console.warn('[fig-viewer] desktop/web 0.2.0 服务不完整，交互视图降级关闭')
        return
      }
      // R2-0 的 hello 探针模式独占安装（避免双注册）。
      if (window.location && new URL(window.location.href).searchParams.get('figviewHello') === '1') return

      var FIGURE_KEY = 'bio-figures'
      var IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp)$/i
      var MAX_JSON_TOTAL_BYTES = 8 * 1024 * 1024 // R1 合同：bundle 三份 JSON 合计预算
      var MAX_MANIFEST_BYTES = 1024 * 1024       // manifest 通常几 KB；超 1MiB 即异常
      var MAX_POINTS = 10000                     // R1 点预算（消费侧复核）
      var READ_SEG_BYTES = 1024 * 1024           // 有界读取分段（≤ 宿主 range 上限）
      var MAX_FRAME_IMAGE_BYTES = 4 * 1024 * 1024 // 图片内嵌上限（显示附件；超出即省略并注明原因）

      // ---- bundle 内引用路径校验（复刻 figview_validate._resolve 的字符串层规则）----
      function unsafeBundlePath(p) {
        if (typeof p !== 'string' || !p) return '不是字符串或为空'
        if (p.includes('\\')) return '含反斜杠'
        if (p.includes(':')) return '含冒号（盘符/URL/scheme）'
        if (p.includes('%')) return '含百分号编码'
        if (p.includes('\u0000')) return '含 NUL'
        if (p.charAt(0) === '/') return '绝对路径'
        var parts = p.split('/')
        for (var i = 0; i < parts.length; i += 1) {
          if (parts[i] === '' || parts[i] === '.' || parts[i] === '..') return '含空/./.. 路径分量'
        }
        return null
      }
      var SHA256_RE = /^[0-9a-f]{64}$/
      // 引用对象校验：返回错误文案或 null。null 合法性由调用处按 capabilities 决定。
      function refError(ref, label) {
        if (typeof ref !== 'object' || ref === null) return label + ' 引用类型非法'
        var perr = unsafeBundlePath(ref.path)
        if (perr) return label + ' 路径非法：' + perr
        if (typeof ref.sha256 !== 'string' || !SHA256_RE.test(ref.sha256)) {
          return label + ' 缺少合法 sha256（64 位小写 hex）'
        }
        return null
      }
      // 从 manifest 路径提取 revision：取【直接父目录】（.../<figure_id>/<rev>/<name>）；
      // 缺 64hex 直接父目录 = 非发布布局（生产入口拒绝，避免「任意位置首次匹配」的歧义）。
      var CH_LF = String.fromCharCode(10)
      var CH_CR = String.fromCharCode(13)
      var CH_TAB = String.fromCharCode(9)
      var CH_BS = String.fromCharCode(92)
      function expectedRevisionOf(manifestPath) {
        var norm = String(manifestPath).split(CH_BS).join('/')
        var parts = norm.split('/')
        if (parts.length < 2) return null
        var parent = parts[parts.length - 2]
        return /^[0-9a-f]{64}$/.test(parent) ? parent : null
      }
      // ---- manifest 内容自洽核验（R2-2.3：fatal UTF-8 + 结构病理检测 + 字节手术）----
      var MAX_JSON_DEPTH = 1000
      function validateJsonStructure(text) {
        // 全遍历：重复键（解码后比较）、非有限数值、深度上限、结构与字面量合法性。
        var n = text.length
        var i = 0
        function skipWs() {
          while (i < n && (text[i] === ' ' || text[i] === CH_LF || text[i] === CH_TAB || text[i] === CH_CR)) i += 1
        }
        function scanStringRaw() {
          if (text[i] !== '"') return null
          var start = i
          i += 1
          while (i < n) {
            var c = text[i]
            if (c === CH_BS) { i += 2; continue }
            if (c === '"') { i += 1; return text.slice(start, i) }
            i += 1
          }
          return null
        }
        function decodeKey(raw) {
          try { return JSON.parse(raw) } catch (err) { return null }
        }
        function scanScalar() {
          var start = i
          while (i < n) {
            var t = text[i]
            if (t === ',' || t === '}' || t === ']' || t === ' ' || t === CH_LF || t === CH_TAB || t === CH_CR) break
            i += 1
          }
          var tok = text.slice(start, i)
          if (!tok) return '空标量 token'
          if (tok === 'true' || tok === 'false' || tok === 'null') return null
          var num = Number(tok)
          if (!isFinite(num)) return '非有限或非法数值：' + tok.slice(0, 30)
          return null
        }
        var stack = []
        skipWs()
        if (i >= n) return '空文本'
        var first = text[i]
        if (first !== '{' && first !== '[') return '顶层不是对象/数组'
        stack.push({ kind: first === '{' ? 'obj' : 'arr', keys: first === '{' ? Object.create(null) : null })
        i += 1
        for (;;) {
          if (stack.length > MAX_JSON_DEPTH) return '嵌套超过深度上限（' + MAX_JSON_DEPTH + '）'
          skipWs()
          if (i >= n) return '结构中途结束'
          var top = stack[stack.length - 1]
          var ch = text[i]
          if (top.kind === 'obj') {
            if (ch === '}') { i += 1; stack.pop(); if (!stack.length) { skipWs(); return i === n ? null : '尾部有杂质' } continue }
            if (ch === ',') { i += 1; continue }
            var raw = scanStringRaw()
            if (raw === null) return '对象键非法（位置 ' + i + '）'
            var key = decodeKey(raw)
            if (key === null) return '对象键解码失败'
            if (top.keys[key]) return '重复键：' + key
            top.keys[key] = true
            skipWs()
            if (text[i] !== ':') return '键后缺冒号'
            i += 1
            skipWs()
            if (i >= n) return '结构中途结束'
            var vch = text[i]
            if (vch === '{' || vch === '[') { stack.push({ kind: vch === '{' ? 'obj' : 'arr', keys: vch === '{' ? Object.create(null) : null }); i += 1; continue }
            if (vch === '"') { if (scanStringRaw() === null) return '字符串未闭合'; continue }
            var err1 = scanScalar()
            if (err1) return err1
            continue
          }
          if (ch === ']') { i += 1; stack.pop(); if (!stack.length) { skipWs(); return i === n ? null : '尾部有杂质' } continue }
          if (ch === ',') { i += 1; continue }
          var vch2 = text[i]
          if (vch2 === '{' || vch2 === '[') { stack.push({ kind: vch2 === '{' ? 'obj' : 'arr', keys: vch2 === '{' ? Object.create(null) : null }); i += 1; continue }
          if (vch2 === '"') { if (scanStringRaw() === null) return '字符串未闭合'; continue }
          var err2 = scanScalar()
          if (err2) return err2
        }
      }
      function stripTopLevelMemberText(text, member) {
        var n = text.length
        var i = 0
        function skipWs() {
          while (i < n && (text[i] === ' ' || text[i] === CH_LF || text[i] === CH_TAB || text[i] === CH_CR)) i += 1
        }
        function scanString() {
          if (text[i] !== '"') return false
          i += 1
          while (i < n) {
            var c = text[i]
            if (c === CH_BS) { i += 2; continue }
            if (c === '"') { i += 1; return true }
            i += 1
          }
          return false
        }
        function scanValue() {
          skipWs()
          var c = text[i]
          if (c === '"') return scanString()
          if (c === '{' || c === '[') {
            var depth = 0
            while (i < n) {
              var ch = text[i]
              if (ch === '"') { if (!scanString()) return false; continue }
              if (ch === '{' || ch === '[') depth += 1
              else if (ch === '}' || ch === ']') { depth -= 1; if (depth === 0) { i += 1; return true } }
              i += 1
            }
            return false
          }
          var start = i
          while (i < n) {
            var t = text[i]
            if (t === ',' || t === '}' || t === ']' || t === ' ' || t === CH_LF || t === CH_TAB || t === CH_CR) break
            i += 1
          }
          return i > start
        }
        skipWs()
        if (text[i] !== '{') return null
        i += 1
        var members = []
        skipWs()
        if (text[i] === '}') {
          i += 1
        } else {
          for (;;) {
            skipWs()
            var ks = i
            if (!scanString()) return null
            var keyRaw = text.slice(ks, i)
            skipWs()
            if (text[i] !== ':') return null
            i += 1
            if (!scanValue()) return null
            members.push({ start: ks, end: i, isTarget: keyRaw === '"' + member + '"' })
            skipWs()
            if (text[i] === ',') { i += 1; continue }
            if (text[i] === '}') { i += 1; break }
            return null
          }
        }
        skipWs()
        if (i !== n) return null
        var idx = -1
        for (var m = 0; m < members.length; m += 1) { if (members[m].isTarget) { idx = m; break } }
        if (idx === -1) return null
        var pieces = []
        for (var m2 = 0; m2 < members.length; m2 += 1) {
          if (m2 === idx) continue
          pieces.push(text.slice(members[m2].start, members[m2].end))
        }
        return '{' + pieces.join(',') + '}'
      }
      function verifyManifestDigest(bytes, revision) {
        if (typeof revision !== 'string' || !SHA256_RE.test(revision)) {
          return Promise.resolve('revision 非法（须为 64 位小写 hex）')
        }
        var text
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        catch (errU) { return Promise.resolve('manifest 非合法 UTF-8（拒绝）') }
        var vErr = validateJsonStructure(text)
        if (vErr) return Promise.resolve('manifest 结构非法：' + vErr)
        var strippedText = stripTopLevelMemberText(text, 'revision')
        if (strippedText === null) return Promise.resolve('manifest 无法剥离 revision 成员')
        var stripped = new TextEncoder().encode(strippedText)
        return sha256Hex(stripped).then(function (actual) {
          return actual === revision.toLowerCase() ? null
            : '内容摘要与 revision 不一致（内容被改动或非 canonical 输出）'
        })
      }
      // ---- 地址 codec：dsh-resource://bio-figure/session/<sid>/<encoded manifest path> ----
      function encodeFigureAddress(sessionId, manifestPath) {
        return 'dsh-resource://bio-figure/session/' + encodeURIComponent(String(sessionId)) + '/' + encodeURIComponent(manifestPath)
      }
      function decodeFigureAddress(address) {
        var m = /^dsh-resource:\/\/bio-figure\/session\/([^/]+)\/(.+)$/.exec(String(address || ''))
        if (!m) return null
        try { return { sessionId: decodeURIComponent(m[1]), manifestPath: decodeURIComponent(m[2]) } }
        catch (err) { return null }
      }

      // ---- 工具结果解析：受控 JSON 信封 + 图片内容块（不从任意 Markdown 猜映射）----
      function textBlocksOf(event) {
        var blocks = event && event.data && event.data.message && event.data.message.content
        if (!Array.isArray(blocks)) return []
        var out = []
        for (var i = 0; i < blocks.length; i += 1) {
          var b = blocks[i]
          if (b && b.type === 'text' && typeof b.text === 'string' && b.text) out.push(b.text)
        }
        return out
      }
      function parseWholeJson(text) {
        var t = String(text || '').trim()
        if (!t || t.charAt(0) !== '{' || t.charAt(t.length - 1) !== '}') return null
        try { return JSON.parse(t) } catch (err) { return null }
      }
      function refKeyOf(ref) { return ref.kind === 'sidecar' ? ref.manifest : ref.imagePath }
      function fullRefKey(ref) { return ref.kind + '|' + refKeyOf(ref) }
      function refsFromPayload(payload, refs) {
        if (!payload || typeof payload !== 'object') return
        var r = (payload.result && typeof payload.result === 'object') ? payload.result : payload
        if (typeof r.viewer_manifest === 'string' && r.viewer_manifest) {
          refs.push({ kind: 'sidecar', manifest: r.viewer_manifest,
            figureId: typeof r.figure_id === 'string' ? r.figure_id : null,
            imagePath: typeof r.out_file === 'string' ? r.out_file : null,
            name: typeof r.name === 'string' ? r.name : null })
          return
        }
        // bio_fig_export 输出链（受控形状：results[].viewer 显式声明可交互）——
        if (Array.isArray(r.results)) {
          for (var i = 0; i < r.results.length; i += 1) {
            var item = r.results[i]
            if (!item || typeof item !== 'object') continue
            if (item.viewer && typeof item.viewer === 'object' && item.viewer.available === true &&
                typeof item.viewer.manifest === 'string' && item.viewer.manifest) {
              refs.push({ kind: 'sidecar', manifest: item.viewer.manifest,
                figureId: typeof item.viewer.figure_id === 'string' ? item.viewer.figure_id : null,
                imagePath: typeof item.path === 'string' ? item.path : null,
                name: null })
            } else if (typeof item.path === 'string' && IMAGE_EXT.test(item.path) && typeof item.verdict === 'string') {
              refs.push({ kind: 'preview', imagePath: item.path, manifest: null, figureId: null, name: null })
            }
          }
          return
        }
        if (typeof r.out_file === 'string' && IMAGE_EXT.test(r.out_file)) {
          refs.push({ kind: 'preview', imagePath: r.out_file, manifest: null, figureId: null,
            name: typeof r.name === 'string' ? r.name : null })
        }
      }
      function extractFigureRefs(event) {
        if (!event || event.type !== 'tool/result') return []
        if (event.data && event.data.message && event.data.message.isError) return []
        var texts = textBlocksOf(event)
        if (!texts.length) return []
        var refs = []
        for (var t = 0; t < texts.length; t += 1) {
          var text = texts[t]
          var payload = parseWholeJson(text)
          if (payload) refsFromPayload(payload, refs)
          var imgRe = /<path>([^<]+)<\/path>\s*<type>image<\/type>/g
          var m
          while ((m = imgRe.exec(text)) !== null) {
            var p = m[1].trim()
            if (p) refs.push({ kind: 'preview', imagePath: p, manifest: null, figureId: null, name: null })
          }
        }
        var seen = Object.create(null) // 防原型污染（__proto__ 等键）
        return refs.filter(function (ref) {
          var k = fullRefKey(ref)
          if (seen[k]) return false
          seen[k] = true
          return true
        })
      }

      // ---- Turn 数据 Definition：tool/result → bio-figures（发布后由 turnTail 消费）----
      var definition = {
        kind: 'bio-figures',
        match: function (event) {
          if (!event || !event.data) return null
          if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
          if (event.type === 'tool/result' && extractFigureRefs(event).length) {
            return { id: String(event.data.turn), role: 'update' }
          }
          return null
        },
        start: function (context, match) {
          return { turn: match.event.data.turn, figures: [] }
        },
        update: function (context, match) {
          var state = context.state || { turn: match.event.data.turn, figures: [] }
          var refs = extractFigureRefs(match.event)
          var next = state.figures.slice()
          var changed = false
          refs.forEach(function (ref) {
            var k = fullRefKey(ref)
            if (next.some(function (x) { return fullRefKey(x) === k })) return
            next.push({ kind: ref.kind, manifest: ref.manifest || null, imagePath: ref.imagePath || null,
              figureId: ref.figureId || null, name: ref.name || null, seq: match.event.seq })
            changed = true
          })
          if (!changed) return state
          return { turn: state.turn, figures: next }
        },
        buildLocationData: function (context, scope, previous) {
          if (scope !== 'turn' || !context.state) return null
          var value = { figures: context.state.figures }
          if (previous && previous.kind === 'turn' && previous.turn === context.state.turn &&
              previous.key === FIGURE_KEY && JSON.stringify(previous.value) === JSON.stringify(value)) {
            return previous
          }
          return { kind: 'turn', turn: context.state.turn, key: FIGURE_KEY, value: value }
        },
      }
      ctx.uiConversation.events.register(definition)

      // ---- 字节/校验工具 ----
      function toBytes(data) {
        if (!data) return null
        if (typeof data === 'string') {
          try {
            var bin = atob(data)
            var arr = new Uint8Array(bin.length)
            for (var i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i)
            return arr
          } catch (err) { return null }
        }
        if (Array.isArray(data)) return new Uint8Array(data)
        if (typeof data === 'object') {
          // 跨 realm 安全：不用 instanceof（vm / iframe 下的 typed array 原型不同域）。
          var tag = Object.prototype.toString.call(data)
          if (tag === '[object Uint8Array]') return new Uint8Array(data)
          if (tag === '[object ArrayBuffer]') return new Uint8Array(data)
          if (data.type === 'Buffer' && Array.isArray(data.data)) return new Uint8Array(data.data)
          if (typeof data.byteLength === 'number' && typeof data.byteOffset === 'number' && data.buffer) {
            try { return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) } catch (err) { /* fallthrough */ }
          }
        }
        return null
      }
      function bytesToText(bytes) { return new TextDecoder('utf-8').decode(bytes) }
      function sha256Hex(bytes) {
        return crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
          var view = new Uint8Array(digest)
          var hex = ''
          for (var i = 0; i < view.length; i += 1) hex += (view[i] < 16 ? '0' : '') + view[i].toString(16)
          return hex
        })
      }
      function verifySha(bytes, expected, label) {
        // fail-closed：调用方已保证 expected 为合法 64 位 hex（refError 前置校验），此处只做比对。
        return sha256Hex(bytes).then(function (actual) {
          if (actual !== String(expected).toLowerCase()) {
            throw new Error(label + ' sha256 校验失败（期望 ' + expected + '，实际 ' + actual + '）')
          }
        })
      }
      function safeJson(bytes, label) {
        try { return JSON.parse(bytesToText(bytes)) }
        catch (err) { throw new Error(label + ' 不是合法 JSON：' + err.message) }
      }
      function basenameOf(p) { var s = String(p).split(/[\\/]/); return s[s.length - 1] || '?' }
      function isWinDrivePath(s) {
        return s.length >= 3 && s.charAt(1) === ':' && s.charAt(2) === '/' && /[A-Za-z]/.test(s.charAt(0))
      }
      function isUncPath(s) { return s.length >= 2 && s.charAt(0) === '/' && s.charAt(1) === '/' }
      function normalizeAbsPath(p) {
        if (typeof p !== 'string' || !p) return null
        var s = String(p).split(CH_BS).join('/')
        var parts = s.split('/')
        var out = []
        for (var i = 0; i < parts.length; i += 1) {
          var seg = parts[i]
          if (seg === '.' || seg === '..') return null
          out.push(seg)
        }
        return out.join('/')
      }
      function pathWithinBundle(bundleDirNorm, candidateRaw) {
        var cand = normalizeAbsPath(candidateRaw)
        if (cand === null) return false
        var dir = bundleDirNorm
        if ((isWinDrivePath(cand) && isWinDrivePath(dir)) || (isUncPath(cand) && isUncPath(dir))) {
          return cand.toLowerCase().indexOf(dir.toLowerCase()) === 0
        }
        return cand.indexOf(dir) === 0
      }
      // 严格 JSON 读取入口（R2-2.4）：fatal UTF-8 → 结构病理 → JSON.parse。
      // rows/hits 与 manifest 共用同一条防线；不得绕过。
      function strictJsonDecode(bytes, label) {
        var text
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        catch (errU) { throw new Error(label + ' 非合法 UTF-8（拒绝）') }
        var vErr = validateJsonStructure(text)
        if (vErr) throw new Error(label + ' 结构非法：' + vErr)
        try { return JSON.parse(text) }
        catch (errP) { throw new Error(label + ' 不是合法 JSON：' + errP.message) }
      }
      function abortError() { var e = new Error('aborted'); e.name = 'AbortError'; return e }
      function concatBytes(chunks, total) {
        var out = new Uint8Array(total)
        var off = 0
        for (var ci = 0; ci < chunks.length; ci += 1) { out.set(chunks[ci], off); off += chunks[ci].length }
        return out
      }
      function unwrapReadResult(res, label) {
        if (!res || typeof res !== 'object') throw new Error(label + ' 读取响应非法')
        if (res.ok === false) throw new Error(label + ' 读取失败：' + JSON.stringify(res.error || res).slice(0, 240))
        if ('ok' in res && res.ok !== true) throw new Error(label + ' 读取响应信封非法（ok=' + JSON.stringify(res.ok) + '）')
        return (res.value !== undefined) ? res.value : res
      }
      function bytesOfPayload(payload, label) {
        var dataField = (payload && typeof payload === 'object' && payload.data !== undefined) ? payload.data : payload
        if (Array.isArray(dataField)) {
          for (var i = 0; i < dataField.length; i += 1) {
            var v = dataField[i]
            if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(label + ' 字节数组元素非法（index ' + i + '）')
          }
        }
        var bytes = toBytes(dataField)
        if (!bytes) throw new Error(label + ' 读取内容无法转换为字节')
        return bytes
      }
      // 有界读取：range 分段（≤ READ_SEG_BYTES），累计超 cap 即 fail-closed；核验宿主读取身份
      // （offset / absolutePath / version / size 预检）——把截断与跨版本拼接挡在读取层。
      async function readBounded(sessionId, path, baseFile, cap, signal) {
        var label = basenameOf(path)
        var chunks = []
        var total = 0
        var offset = 0
        var meta = { absPath: null, version: null, size: null }
        var completed = false
        for (var iter = 0; iter < 64; iter += 1) {
          if (signal && signal.aborted) throw abortError()
          var want = Math.min(READ_SEG_BYTES, cap + 1 - total)
          if (want <= 0) break
          var opts = { range: { offset: offset, length: want } }
          if (baseFile) opts.baseFile = baseFile
          var res = await ctx.remote.workspaceFiles.readBytes(sessionId, path, opts, signal)
          var payload = unwrapReadResult(res, label)
          if (!payload || typeof payload !== 'object') throw new Error(label + ' 读取响应缺载荷')
          var obsOffset = payload.offset
          if (typeof obsOffset === 'number' && obsOffset !== offset) {
            throw new Error(label + ' 读取 offset 不符（期望 ' + offset + '，得到 ' + obsOffset + '）')
          }
          var sizeHint = payload.bytes
          if (typeof sizeHint === 'number') {
            if (iter === 0) {
              meta.size = sizeHint
              if (sizeHint > cap) {
                throw new Error(label + ' 超出预算（文件 ' + sizeHint + ' 字节 > ' + cap + '，读取前即止）')
              }
            } else if (meta.size !== null && sizeHint !== meta.size) {
              throw new Error(label + ' 读取期间文件大小变化')
            }
          }
          if (iter === 0) {
            meta.absPath = (typeof payload.absolutePath === 'string' && payload.absolutePath) ? payload.absolutePath : null
            meta.version = (payload.version !== undefined) ? payload.version : null
          } else {
            if (meta.absPath && typeof payload.absolutePath === 'string' && payload.absolutePath !== meta.absPath) {
              throw new Error(label + ' 读取期间文件路径变化')
            }
            if (meta.version !== null && payload.version !== undefined && payload.version !== meta.version) {
              throw new Error(label + ' 读取期间文件版本变化')
            }
          }
          var bytes = bytesOfPayload(payload, label)
          if (bytes.length > want) {
            throw new Error(label + ' 段长超过请求（' + bytes.length + ' > ' + want + '）')
          }
          if (total + bytes.length > cap) {
            throw new Error(label + ' 超出预算（>' + cap + ' 字节，读取阶段即止）')
          }
          chunks.push(bytes)
          total += bytes.length
          if (typeof payload.eof !== 'boolean') {
            throw new Error(label + ' 宿主响应缺少布尔 eof（无法确认读取完成）')
          }
          var eofFlag = payload.eof
          if (eofFlag === true) { completed = true; break }
          if (bytes.length === 0) {
            if (eofFlag === false) throw new Error(label + ' 读取停滞（0 进度且 eof=false）')
            completed = true
            break
          }
          offset += bytes.length
        }
        if (!completed) {
          throw new Error(label + ' 读取未达到 EOF（段数上限内未完成，拒绝拼接）')
        }
        if (meta.size !== null && total !== meta.size) {
          throw new Error(label + ' 累计字节与文件大小不符（' + total + ' vs ' + meta.size + '）')
        }
        return { bytes: concatBytes(chunks, total), meta: meta }
      }
      // ---- provider：真实读取 + 逐文件 sha256 校验（与 R1 §3.1 帧语义一致）----
      var REQUIRED_MANIFEST = ['schema_version', 'figure_id', 'revision', 'parent_revision', 'image', 'data', 'hitmap', 'capabilities', 'source', 'recipe', 'provenance', 'redraw']
      function frameError(code, message) { return { ok: false, error: { code: code, message: String(message) } } }
      ctx.resources.register({
        protocol: 'bio-figure',
        async *open(resourceAddress, options) {
          var signal = options && options.signal
          var aborted = function () { return !!(signal && signal.aborted) }
          var parsed = decodeFigureAddress(resourceAddress)
          if (!parsed) { yield frameError('figview/unsupported-address', resourceAddress + ' 不是有效的 bio-figure 地址'); return }
          try {
            if (aborted()) return
            // 1) manifest：有界读取 + 内容自洽核验（字节级）+ 发布布局绑定
            var mRead = await readBounded(parsed.sessionId, parsed.manifestPath, null, MAX_MANIFEST_BYTES, signal)
            if (aborted()) return
            var mBytes = mRead.bytes
            var manifest = safeJson(mBytes, 'manifest')
            for (var i = 0; i < REQUIRED_MANIFEST.length; i += 1) {
              if (manifest === null || typeof manifest !== 'object' || manifest[REQUIRED_MANIFEST[i]] === undefined) {
                throw new Error('manifest 缺少字段：' + REQUIRED_MANIFEST[i])
              }
            }
            if (manifest.schema_version !== 1) throw new Error('不支持的 schema_version：' + JSON.stringify(manifest.schema_version))
            var digestErr = await verifyManifestDigest(mBytes, manifest.revision)
            if (digestErr) throw new Error(digestErr)
            var expectedRev = expectedRevisionOf(parsed.manifestPath)
            if (!expectedRev) throw new Error('manifest 路径缺少 revision 目录（非发布布局）：' + parsed.manifestPath)
            if (String(manifest.revision).toLowerCase() !== expectedRev) {
              throw new Error('manifest revision 与路径不一致（expected ' + expectedRev + '，got ' + manifest.revision + '）')
            }
            // 2) capabilities 严格校验 + 引用校验（fail-closed；null 合法性按 inspect 决定；image 必须为引用）
            var caps = manifest.capabilities
            if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw new Error('capabilities 非法（须为对象）')
            if (caps.inspect !== 'points' && caps.inspect !== 'preview') {
              throw new Error('capabilities.inspect 非法：' + JSON.stringify(caps.inspect))
            }
            if (typeof caps.request_redraw !== 'boolean') throw new Error('capabilities.request_redraw 非法')
            if (!('reason' in caps) || (caps.reason !== null && !(typeof caps.reason === 'string' && caps.reason.length >= 1))) throw new Error('capabilities.reason 非法（null 或非空字符串）')
            var needsPoints = caps.inspect === 'points'
            if (manifest.data === null) {
              if (needsPoints) throw new Error('data 为 null 但 capabilities.inspect=points（预览产物不可作点查）')
            } else {
              var dataErr = refError(manifest.data, 'data')
              if (dataErr) throw new Error(dataErr)
            }
            if (manifest.hitmap === null) {
              if (needsPoints) throw new Error('hitmap 为 null 但 capabilities.inspect=points')
            } else {
              var hitErr = refError(manifest.hitmap, 'hitmap')
              if (hitErr) throw new Error(hitErr)
            }
            if (manifest.image === null) throw new Error('image 不能为 null')
            var imgErr2 = refError(manifest.image, 'image')
            if (imgErr2) throw new Error(imgErr2)
            var isPlainObject = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
            if (!isPlainObject(manifest.source)) throw new Error('source 类型非法（须为对象）')
            if (['file', 'dataframe', 'none'].indexOf(manifest.source.kind) === -1) throw new Error('source.kind 非法：' + JSON.stringify(manifest.source.kind))
            if (!isPlainObject(manifest.recipe)) throw new Error('recipe 类型非法（须为对象）')
            if (manifest.recipe.recipe_id !== null && !(typeof manifest.recipe.recipe_id === 'string' && manifest.recipe.recipe_id.length >= 1)) throw new Error('recipe.recipe_id 非法')
            if (!isPlainObject(manifest.provenance)) throw new Error('provenance 类型非法（须为对象）')
            if (!isPlainObject(manifest.redraw)) throw new Error('redraw 类型非法（须为对象）')
            if (manifest.parent_revision !== null && !(typeof manifest.parent_revision === 'string' && SHA256_RE.test(manifest.parent_revision))) throw new Error('parent_revision 非法（null 或 64 位小写 hex 字符串）')
            // 3) rows/hits：有界读取 + sha 校验 + 结构·引用·边界校验（三份 JSON 累计预算）
            var totalBytes = mBytes.length
            var rows = null
            var hits = null
            var dirNormFull = normalizeAbsPath(mRead.meta.absPath)
            if (!dirNormFull) throw new Error('宿主未提供规范路径（absolutePath 缺失或异常），无法验证 bundle 边界')
            var bundleDirAbs = dirNormFull.slice(0, dirNormFull.lastIndexOf('/') + 1)
            if (manifest.data) {
              var rRead = await readBounded(parsed.sessionId, manifest.data.path, parsed.manifestPath,
                MAX_JSON_TOTAL_BYTES - totalBytes, signal)
              if (aborted()) return
              totalBytes += rRead.bytes.length
              if (!rRead.meta.absPath) throw new Error('宿主未提供 rows 的规范路径，无法验证 bundle 边界')
              if (!pathWithinBundle(bundleDirAbs, rRead.meta.absPath)) throw new Error('rows 的最终路径在 bundle 之外：' + rRead.meta.absPath)
              await verifySha(rRead.bytes, manifest.data.sha256, 'rows')
              if (aborted()) return
              rows = strictJsonDecode(rRead.bytes, 'rows')
              if (!rows || typeof rows !== 'object' || !Array.isArray(rows.rows) || !Array.isArray(rows.columns)) {
                throw new Error('rows 结构非法（rows/columns 必须是数组）')
              }
              if (rows.schema_version !== 1) throw new Error('rows schema_version 非法：' + JSON.stringify(rows.schema_version))
              var seenRowIds = Object.create(null)
              for (var ri = 0; ri < rows.rows.length; ri += 1) {
                var rid = rows.rows[ri] ? rows.rows[ri].row_id : undefined
                if (typeof rid !== 'string' || !rid) throw new Error('rows 存在缺失 row_id（index ' + ri + '）')
                if (seenRowIds[rid]) throw new Error('rows row_id 重复：' + rid)
                seenRowIds[rid] = true
              }
            }
            if (manifest.hitmap) {
              var hRead = await readBounded(parsed.sessionId, manifest.hitmap.path, parsed.manifestPath,
                MAX_JSON_TOTAL_BYTES - totalBytes, signal)
              if (aborted()) return
              totalBytes += hRead.bytes.length
              if (!hRead.meta.absPath) throw new Error('宿主未提供 hits 的规范路径，无法验证 bundle 边界')
              if (!pathWithinBundle(bundleDirAbs, hRead.meta.absPath)) throw new Error('hits 的最终路径在 bundle 之外：' + hRead.meta.absPath)
              await verifySha(hRead.bytes, manifest.hitmap.sha256, 'hits')
              if (aborted()) return
              hits = strictJsonDecode(hRead.bytes, 'hits')
              if (!hits || typeof hits !== 'object' || !Array.isArray(hits.elements)) {
                throw new Error('hits 结构非法（elements 必须是数组）')
              }
              if (hits.schema_version !== 1) throw new Error('hits schema_version 非法：' + JSON.stringify(hits.schema_version))
              if (hits.elements.length > MAX_POINTS) {
                throw new Error('hits 点数超出预算（' + hits.elements.length + ' > ' + MAX_POINTS + '）')
              }
              if (rows) {
                for (var hi = 0; hi < hits.elements.length; hi += 1) {
                  var el = hits.elements[hi]
                  var refIds = el ? el.row_ids : undefined
                  if (!Array.isArray(refIds)) throw new Error('hits 元素缺少 row_ids 数组（index ' + hi + '）')
                  for (var qi = 0; qi < refIds.length; qi += 1) {
                    if (!seenRowIds[refIds[qi]]) throw new Error('hits 引用不存在的 row_id：' + refIds[qi])
                  }
                }
              }
            }
            var imagePayload = null
            if (manifest.image && manifest.image.path) {
              try {
                var iRead = await readBounded(parsed.sessionId, manifest.image.path, parsed.manifestPath, MAX_FRAME_IMAGE_BYTES, signal)
                if (aborted()) return
                if (!iRead.meta.absPath) throw new Error('宿主未提供 image 的规范路径')
                if (!pathWithinBundle(bundleDirAbs, iRead.meta.absPath)) throw new Error('image 的最终路径在 bundle 之外：' + iRead.meta.absPath)
                await verifySha(iRead.bytes, manifest.image.sha256, 'image')
                imagePayload = {
                  mime: mimeOfPath(manifest.image.path),
                  dataBase64: bytesToBase64(iRead.bytes),
                  width: manifest.image.width,
                  height: manifest.image.height,
                }
              } catch (imgError) {
                // 图片为显示附件：读取/校验失败不阻断数据查看（rows/hits 仍严格 fail-closed），但记录原因。
                imagePayload = { omitted: true, reason: (imgError && imgError.message) || String(imgError) }
              }
            }
            if (aborted()) return
            yield { ok: true, value: { manifest: manifest, rows: rows, hits: hits, image: imagePayload } }

          } catch (error) {
            if (error && error.name === 'AbortError') return
            if (aborted()) return
            var code = error && error.code ? String(error.code) : 'figview/read-failed'
            yield frameError(code, (error && error.message) || error)
          }
        },
      })

      // ---- tab 类型：bio-figure 地址 → 本查看器 ----
      ctx.sidebarRightTabs.register({
        id: 'bio-figure-viewer',
        kind: 'bio-figure',
        patterns: ['dsh-resource://bio-figure/**'],
        canOpen: function (candidate) { return decodeFigureAddress(candidate) !== null },
        title: function (candidate) {
          var p = decodeFigureAddress(candidate)
          if (!p) return 'Figure'
          var seg = String(p.manifestPath).split(/[\\/]/).pop() || 'figure'
          return seg.replace(/\.figview\.json$/i, '')
        },
      })

      // ---- turnTail 缩略卡：本回合图产物 + 打开入口 ----
      function FiguresCard(props) {
        var data = null
        try {
          data = props.turn && props.turn.data && typeof props.turn.data.get === 'function'
            ? props.turn.data.get(FIGURE_KEY) : null
        } catch (err) { data = null }
        var figures = (data && data.figures) || []
        if (!figures.length) return null
        return createElement('div', { 'data-figview': 'turn-card',
          style: { border: '1px solid currentColor', borderRadius: 6, padding: '8px 10px', marginTop: 8, opacity: 0.95 } },
          createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, '图表（' + figures.length + '）'),
          figures.map(function (f, i) {
            var label = f.name || f.figureId || String(f.imagePath || f.manifest || '').split(/[\\/]/).pop()
            var action = null
            if (f.kind === 'sidecar') {
              action = createElement('button', { key: 'open', type: 'button', style: { marginLeft: 8 },
                onClick: function () { ctx.sidebarRight.openResource(encodeFigureAddress(props.sessionId, f.manifest)) } }, '交互查看')
            } else if (typeof props.openFile === 'function' && f.imagePath) {
              action = createElement('button', { key: 'open', type: 'button', style: { marginLeft: 8 },
                onClick: function () { props.openFile(f.imagePath) } }, '打开图片')
            }
            return createElement('div', { key: i, style: { display: 'flex', alignItems: 'center', padding: '2px 0' } },
              createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                label + ' · ' + (f.kind === 'sidecar' ? '可交互' : '预览')),
              action)
          }))
      }
      ctx.slots.inject('conversation.chat.turnTail', function () {
        return ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'bio-figures', order: 48 }, FiguresCard)
      })

      // ---- R2-3：完整画布查看器（zoom / pan / fit + 点选反查 + 行数据浮窗）----
      // 坐标约定（R1 §2.2）：hits 几何为图像像素（top-left 原点、边界连续）；
      // 视图矩阵 V: css = u * scale + tx。DPR 仅影响绘制，命中统一 CSS px。
      function fitView(nw, nh, vw, vh) {
        if (!(nw > 0 && nh > 0 && vw > 0 && vh > 0)) return { scale: 1, tx: 0, ty: 0 }
        var s = Math.min(vw / nw, vh / nh) * 0.98
        return { scale: s, tx: (vw - nw * s) / 2, ty: (vh - nh * s) / 2 }
      }
      function viewAtScale(nw, nh, vw, vh, scale) {
        return { scale: scale, tx: (vw - nw * scale) / 2, ty: (vh - nh * scale) / 2 }
      }
      function zoomAt(view, factor, cx, cy) {
        var lo = Math.min(0.02, view.scale)
        var s2 = Math.max(lo, Math.min(64, view.scale * factor))
        var k = s2 / view.scale
        return { scale: s2, tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k }
      }
      function toImageCoords(view, cx, cy) {
        return { u: (cx - view.tx) / view.scale, v: (cy - view.ty) / view.scale }
      }
      function hitTestElements(elements, u, v, cssRadius, scale) {
        var rImg = cssRadius / (typeof scale === 'number' && isFinite(scale) && scale > 0 ? scale : 1)
        var out = []
        if (!Array.isArray(elements)) return out
        for (var i = 0; i < elements.length; i += 1) {
          var el = elements[i]
          if (!el || !el.geometry || !Array.isArray(el.geometry.center)) continue
          var cx = el.geometry.center[0]
          var cy = el.geometry.center[1]
          if (typeof cx !== 'number' || typeof cy !== 'number' || !isFinite(cx) || !isFinite(cy)) continue
          var er = (typeof el.geometry.radius === 'number' && isFinite(el.geometry.radius) && el.geometry.radius >= 0) ? el.geometry.radius : 0
          // 合同：off-clip 几何保留但不可选中——点击位置必须先落在元素 clip 内（复刻 figview_validate 口径）。
          if (Array.isArray(el.clip) && el.clip.length >= 4) {
            if (u < el.clip[0] || v < el.clip[1] || u > el.clip[2] || v > el.clip[3]) continue
          }
          var du = cx - u
          var dv = cy - v
          var d = Math.sqrt(du * du + dv * dv)
          if (d <= er + rImg) {
            out.push({ el: el, dist: Math.max(0, d - er),
              z: (typeof el.zorder === 'number' ? el.zorder : 0),
              dr: (typeof el.draw_order === 'number' ? el.draw_order : 0) })
          }
        }
        out.sort(function (a, b) {
          if (a.dist !== b.dist) return a.dist - b.dist
          if (a.z !== b.z) return b.z - a.z
          if (a.dr !== b.dr) return b.dr - a.dr
          var aid = a.el && a.el.element_id ? String(a.el.element_id) : ''
          var bid = b.el && b.el.element_id ? String(b.el.element_id) : ''
          return aid < bid ? -1 : aid > bid ? 1 : 0
        })
        return out
      }      function mimeOfPath(path) {
        var s = String(path).toLowerCase()
        if (s.slice(-4) === '.png') return 'image/png'
        if (s.slice(-4) === '.jpg' || s.slice(-5) === '.jpeg') return 'image/jpeg'
        if (s.slice(-4) === '.svg') return 'image/svg+xml'
        if (s.slice(-5) === '.webp') return 'image/webp'
        if (s.slice(-4) === '.gif') return 'image/gif'
        return 'application/octet-stream'
      }
      function bytesToBase64(bytes) {
        var CHUNK = 0x8000
        var parts = []
        for (var i = 0; i < bytes.length; i += CHUNK) {
          parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)))
        }
        return btoa(parts.join(''))
      }
      function fmtValue(v) {
        if (v === null || v === undefined) return String(v)
        if (typeof v === 'object') {
          if (typeof v.missing === 'string') return 'NA(' + v.missing + ')'
          try { return JSON.stringify(v) } catch (e) { return String(v) }
        }
        return String(v)
      }
      function columnsOf(rowsTable) {
        if (rowsTable && Array.isArray(rowsTable.columns)) {
          var names = []
          for (var i = 0; i < rowsTable.columns.length; i += 1) {
            var c = rowsTable.columns[i]
            if (c && typeof c.name === 'string') names.push(c.name)
          }
          if (names.length) return names
        }
        return ['gene', 'log2FC', 'pvalue', 'padj']
      }
      function renderHitMarkers(hits, sel, view) {
        if (!hits || !Array.isArray(hits.elements)) return null
        var out = []
        for (var i = 0; i < hits.elements.length; i += 1) {
          var el = hits.elements[i]
          if (!el || !el.geometry || !Array.isArray(el.geometry.center)) continue
          if (el.element_id !== sel.elementId) continue
          var r = (typeof el.geometry.radius === 'number' ? el.geometry.radius : 3) * 1.6 + 2
          out.push(createElement('circle', { key: 'c' + i, cx: el.geometry.center[0], cy: el.geometry.center[1],
            r: r, fill: 'none', stroke: '#ff8c00', strokeWidth: 2 / view.scale }))
        }
        return out.length ? out : null
      }

      function FigureViewerTab(props) {
        var info = props.useTabInfo()
        var frame = props.useResource(info.tab.contentId)
        var viewState = useState(null)
        var view = viewState[0]
        var setView = viewState[1]
        var selState = useState(null)
        var sel = selState[0]
        var setSel = selState[1]
        var boxState = useState({ w: 0, h: 0 })
        var box = boxState[0]
        var setBox = boxState[1]
        var imgState = useState('idle')
        var mismatchState = useState(null)
        var sizeMismatch = mismatchState[0]
        var setMismatch = mismatchState[1]
        var imgStatus = imgState[0]
        var setImgStatus = imgState[1]
        var natState = useState(null)
        var nat = natState[0]
        var setNat = natState[1]
        var hostRef = useRef(null)
        var dragRef = useRef(null)
        var wheelRef = useRef(function () {})
        var canvasReady = !!(frame && frame.value && frame.value.manifest)

        useEffect(function () {
          var el = hostRef.current
          if (!el) return undefined
          var cleanups = []
          if (typeof ResizeObserver !== 'undefined') {
            var ro = new ResizeObserver(function (entries) {
              if (!entries || !entries.length) return
              var r = entries[0].contentRect || {}
              setBox({ w: r.width || 0, h: r.height || 0 })
            })
            ro.observe(el)
            cleanups.push(function () { ro.disconnect() })
          }
          function onNativeWheel(ev2) {
            if (ev2.preventDefault) ev2.preventDefault()
            wheelRef.current(ev2)
          }
          var wheelOpts = { passive: false }
          el.addEventListener('wheel', onNativeWheel, wheelOpts)
          cleanups.push(function () { el.removeEventListener('wheel', onNativeWheel, wheelOpts) })
          return function () {
            for (var ci = 0; ci < cleanups.length; ci += 1) cleanups[ci]()
          }
        }, [canvasReady])

        useEffect(function () {
          if (nat && box.w > 0 && box.h > 0 && view === null) {
            setView(fitView(nat.w, nat.h, box.w, box.h))
          }
        }, [nat, box.w, box.h])

        if (!frame || frame.status === 'loading') {
          return createElement('div', { 'data-figview': 'pane-loading', style: { padding: 16 } }, '图数据加载中…')
        }
        if (frame.status === 'error' || frame.status === 'failed' || !frame.value || !frame.value.manifest) {
          var msg = (frame.failure && (frame.failure.message || frame.failure.code))
            || (frame.error && (frame.error.message || frame.error.code)) || '不可用'
          var dbg = null
          try {
            dbg = JSON.stringify(frame, function (k, v) {
              return typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v
            }, 1).slice(0, 1600)
          } catch (errDbg) { dbg = String(errDbg) }
          return createElement('div', { 'data-figview': 'pane-error', style: { padding: 16 } },
            '图数据加载失败：' + msg,
            createElement('pre', { style: { fontSize: 10, overflow: 'auto', maxHeight: 320 } }, dbg))
        }
        var v = frame.value
        var m = v.manifest
        var hits = v.hits
        var rows = v.rows
        var img = (v.image && v.image.dataBase64) ? v.image : null
        var nRows = rows && Array.isArray(rows.rows) ? rows.rows.length : null
        var nPts = hits && Array.isArray(hits.elements) ? hits.elements.length : null
        var summary = 'revision ' + String(m.revision).slice(0, 12) + '… ｜ rows ' + (nRows == null ? '—' : nRows)
          + ' ｜ points ' + (nPts == null ? '—' : nPts) + ' ｜ 源 ' + ((m.source && m.source.kind) || '—')
        var imgSrc = img ? 'data:' + (img.mime || 'image/png') + ';base64,' + img.dataBase64 : null
        var noImage = (!imgSrc || imgStatus === 'error')
        var fallbackReason = imgStatus === 'error'
          ? (sizeMismatch ? ('图片尺寸与 manifest/hitmap 不配对（实际 ' + sizeMismatch.got.w + 'x' + sizeMismatch.got.h + '，期望 ' + sizeMismatch.expect.w + 'x' + sizeMismatch.expect.h + '）') : '图片加载/解码失败')
          : (v.image && v.image.omitted ? ('图片未内嵌：' + (v.image.reason || '')) : (img ? '' : '无图片'))
        var effView = view || ((nat && box.w > 0 && box.h > 0) ? fitView(nat.w, nat.h, box.w, box.h) : null)

        function doHit(clientX, clientY) {
          var host = hostRef.current
          if (!host || !effView || !hits || !Array.isArray(hits.elements)) return
          var rect = host.getBoundingClientRect()
          var offX = rect.left + (host.clientLeft || 0)
          var offY = rect.top + (host.clientTop || 0)
          var p = toImageCoords(effView, clientX - offX, clientY - offY)
          var cands = hitTestElements(hits.elements, p.u, p.v, 8, effView.scale)
          if (!cands.length) {
            setSel({ miss: true, u: p.u, v: p.v })
            return
          }
          var best = cands[0]
          var ids = Array.isArray(best.el.row_ids) ? best.el.row_ids : []
          var matched = []
          if (rows && Array.isArray(rows.rows)) {
            for (var fi = 0; fi < rows.rows.length && matched.length < 50; fi += 1) {
              var row = rows.rows[fi]
              if (row && ids.indexOf(row.row_id) !== -1) matched.push(row)
            }
          }
          setSel({ elementId: best.el.element_id, rowIds: ids, rows: matched, u: p.u, v: p.v })
        }

        wheelRef.current = onWheel
        function onWheel(ev) {
          if (!effView || !hostRef.current) return
          if (ev.preventDefault) ev.preventDefault()
          var host = hostRef.current
          var rect = host.getBoundingClientRect()
          var offX = rect.left + (host.clientLeft || 0)
          var offY = rect.top + (host.clientTop || 0)
          var factor = (ev.deltaY || 0) < 0 ? 1.2 : 1 / 1.2
          setView(zoomAt(effView, factor, ev.clientX - offX, ev.clientY - offY))
        }
        function onMouseDown(ev) {
          dragRef.current = { x: ev.clientX, y: ev.clientY, view: effView, moved: false }
        }
        function onMouseMove(ev) {
          var d = dragRef.current
          if (!d || !d.view) return
          if (ev.buttons === 0) { dragRef.current = null; return }
          var dx = ev.clientX - d.x
          var dy = ev.clientY - d.y
          if (!d.moved && (Math.abs(dx) + Math.abs(dy)) > 3) d.moved = true
          if (d.moved) setView({ scale: d.view.scale, tx: d.view.tx + dx, ty: d.view.ty + dy })
        }
        function onMouseUp(ev) {
          var d = dragRef.current
          dragRef.current = null
          if (!d) return
          if (!d.moved) doHit(ev.clientX, ev.clientY)
        }
        function onKeyDown(ev) {
          if (!effView) return
          var vw = box.w
          var vh = box.h
          if (ev.key === '+' || ev.key === '=') setView(zoomAt(effView, 1.25, vw / 2, vh / 2))
          else if (ev.key === '-') setView(zoomAt(effView, 1 / 1.25, vw / 2, vh / 2))
          else if (ev.key === '0') { if (nat) setView(fitView(nat.w, nat.h, vw, vh)) }
          else if (ev.key === 'ArrowLeft') setView({ scale: effView.scale, tx: effView.tx + 24, ty: effView.ty })
          else if (ev.key === 'ArrowRight') setView({ scale: effView.scale, tx: effView.tx - 24, ty: effView.ty })
          else if (ev.key === 'ArrowUp') setView({ scale: effView.scale, tx: effView.tx, ty: effView.ty + 24 })
          else if (ev.key === 'ArrowDown') setView({ scale: effView.scale, tx: effView.tx, ty: effView.ty - 24 })
          else return
          if (ev.preventDefault) ev.preventDefault()
        }

        var children = [
          createElement('div', { key: 'head', 'data-figview': 'pane-head', style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px' } },
            createElement('strong', null, m.figure_id || 'figure'),
            createElement('span', { style: { opacity: 0.7, fontSize: 12 } }, summary),
            createElement('span', { style: { flex: 1 } }),
            createElement('button', { key: 'fit', type: 'button', onClick: function () { if (nat) setView(fitView(nat.w, nat.h, box.w, box.h)) } }, '适应'),
            createElement('button', { key: 'one', type: 'button', onClick: function () { if (nat) setView(viewAtScale(nat.w, nat.h, box.w, box.h, 1)) } }, '1:1'),
            createElement('button', { key: 'two', type: 'button', onClick: function () { if (nat) setView(viewAtScale(nat.w, nat.h, box.w, box.h, 2)) } }, '2×')),
          createElement('div', {
            key: 'vp',
            'data-figview': 'viewport',
            'data-figview-view': effView ? (effView.scale + ',' + effView.tx + ',' + effView.ty) : '',
            'data-figview-box': box.w + 'x' + box.h,
            'data-figview-natural': nat ? (nat.w + 'x' + nat.h) : '',
            ref: hostRef,
            tabIndex: 0,
            onMouseDown: onMouseDown, onMouseMove: onMouseMove, onMouseUp: onMouseUp,
            onKeyDown: onKeyDown,
            style: { position: 'relative', flex: 1, minHeight: 220, overflow: 'hidden', border: '1px solid currentColor',
              borderRadius: 4, cursor: 'crosshair', outline: 'none' },
          },
            noImage ? createElement('div', { key: 'noimg', 'data-figview': 'no-image', style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 6 } },
              createElement('div', { style: { opacity: 0.75 } }, fallbackReason + '（坐标点选不可用，以下为源表浏览）'),
              createElement('div', { 'data-figview': 'row-browser', style: { overflow: 'auto', maxHeight: 320, fontSize: 12, border: '1px solid currentColor', borderRadius: 4, padding: 6 } },
                (rows && Array.isArray(rows.rows)) ? [
                  createElement('div', { key: 'cnt', style: { fontWeight: 600, marginBottom: 4 } },
                    '源表（' + rows.rows.length + ' 行' + (rows.rows.length > 50 ? '，显示前 50 行' : '') + '）'),
                  createElement('table', { key: 'tb', style: { borderCollapse: 'collapse', width: '100%' } },
                    createElement('thead', { key: 'th' },
                      createElement('tr', null, columnsOf(rows).map(function (col, ci) {
                        return createElement('th', { key: ci, style: { textAlign: 'left', padding: '2px 6px', borderBottom: '1px solid currentColor' } }, col)
                      }))),
                    createElement('tbody', { key: 'tbody' }, rows.rows.slice(0, 50).map(function (row, ri) {
                      return createElement('tr', { key: ri }, columnsOf(rows).map(function (col, ci) {
                        return createElement('td', { key: ci, style: { padding: '2px 6px' } }, fmtValue(row.values ? row.values[col] : undefined))
                      }))
                    }))),
                ] : [createElement('div', { key: 'norows', style: { opacity: 0.7 } }, '无源表数据')]),
            ) : createElement('img', {
              key: 'img', src: imgSrc, alt: m.figure_id || 'figure', draggable: false,
              'data-figview': 'figure-img',
              onLoad: function (ev) {
                var w0 = (ev && ev.target && ev.target.naturalWidth) || (m.image && m.image.width) || 0
                var h0 = (ev && ev.target && ev.target.naturalHeight) || (m.image && m.image.height) || 0
                var mw = (m.image && typeof m.image.width === 'number') ? m.image.width : null
                var mh = (m.image && typeof m.image.height === 'number') ? m.image.height : null
                if (mw !== null && mh !== null && (w0 !== mw || h0 !== mh)) {
                  setImgStatus('error')
                  setMismatch({ got: { w: w0, h: h0 }, expect: { w: mw, h: mh } })
                  return
                }
                if (hits && typeof hits.renderer_width === 'number' && mw !== null && Math.abs(hits.renderer_width - mw) > 1) {
                  setImgStatus('error')
                  setMismatch({ got: { w: hits.renderer_width, h: hits.renderer_height }, expect: { w: mw, h: mh } })
                  return
                }
                setNat({ w: w0, h: h0 })
                var hostEl = (ev && ev.target) ? ev.target.parentElement : null
                if (hostEl) setBox({ w: hostEl.clientWidth || 0, h: hostEl.clientHeight || 0 })
                setImgStatus('loaded')
              },
              onError: function () { setImgStatus('error') },
              style: { position: 'absolute', left: 0, top: 0, transformOrigin: '0 0',
                transform: effView ? ('translate(' + effView.tx + 'px,' + effView.ty + 'px) scale(' + effView.scale + ')') : 'none',
                imageRendering: effView && effView.scale >= 3 ? 'pixelated' : 'auto', userSelect: 'none' },
            }),
            (!noImage && nat && effView && sel && sel.elementId) ? createElement('svg', {
              key: 'ovl', 'data-figview': 'ovl', width: nat.w, height: nat.h,
              style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', transformOrigin: '0 0',
                transform: 'translate(' + effView.tx + 'px,' + effView.ty + 'px) scale(' + effView.scale + ')' },
            }, renderHitMarkers(hits, sel, effView)) : null,
          ),
        ]
        if (sel && sel.rows && sel.rows.length) {
          children.push(createElement('div', {
            key: 'popup', 'data-figview': 'row-popup',
            style: { maxHeight: 180, overflow: 'auto', border: '1px solid currentColor', borderRadius: 4, padding: 8, fontSize: 12 },
          },
            createElement('div', { style: { fontWeight: 600, marginBottom: 4 } },
              '命中数据（展示 ' + sel.rows.length + ' / 共 ' + ((sel.rowIds && sel.rowIds.length) || sel.rows.length) + ' 行'
                + (sel.elementId ? '｜元素 ' + sel.elementId : '') + '）'),
            sel.rows.map(function (row, ri) {
              return createElement('div', { key: ri, style: { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '2px 0' } },
                columnsOf(rows).map(function (col, ci) {
                  return createElement('span', { key: ci },
                    createElement('span', { style: { opacity: 0.6 } }, col + ': '),
                    fmtValue(row.values ? row.values[col] : undefined))
                }))
            })))
        } else if (sel && sel.miss) {
          children.push(createElement('div', { key: 'miss', 'data-figview': 'row-popup-miss', style: { opacity: 0.7, fontSize: 12, padding: '0 10px' } },
            '未命中数据点（图像像素 ' + Math.round(sel.u) + ', ' + Math.round(sel.v) + '）——点击图中散点查看原始数据'))
        } else {
          children.push(createElement('div', { key: 'hint', style: { opacity: 0.6, fontSize: 12, padding: '0 10px' } },
            '滚轮缩放 ｜ 拖拽平移 ｜ 点击数据点查看原始行 ｜ 键盘 +/-/0/方向键'))
        }
        return createElement('div', { 'data-figview': 'pane-v2', style: { display: 'flex', flexDirection: 'column', gap: 6, height: '100%', paddingTop: 6 } }, children)
      }
      exports.__figureViewerMath = {
        fitView: fitView,
        viewAtScale: viewAtScale,
        zoomAt: zoomAt,
        toImageCoords: toImageCoords,
        hitTestElements: hitTestElements,
      }
      ctx.slots.inject('sidebar.right.pane.tab', function () {
        return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'bio-figure-viewer' }, FigureViewerTab)
      })
    }

    function apply(ctx) {
      installFigureHello(ctx)
      installFigureViewer(ctx)
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
    exports.inject = ['slots', 'uiConversation', 'sidebarRight', 'sidebarRightTabs', 'resources', 'remote', 'remote.workspaceFiles']

    return module.exports
  },
})
