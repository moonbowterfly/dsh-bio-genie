// 高级功能模块面板（GET /api/dsh-bio-genie/addons）状态探测回归测试。
// 背景：旧实现对每个 ADDON_MODULE 的每个包逐一 spawnSync `import X` 探测
// （4 模块 12 包 = 12 次 Python 冷启动 + 重模块真实 import），实测 >5.9s。
// 新实现：单子进程 importlib.metadata 元数据枚举（不真正 import 目标模块），<1s。
// 用法：node scripts/test-addons-status.mjs   （需插件 venv 已引导；未引导则 SKIP）
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await import(pathToFileURL(join(repoRoot, 'src', 'runtime.js')).href)

/** 解析插件私有 venv 解释器（与 runtime.resolveEnvDir 默认值一致）。 */
function findPython() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const venv = join(home, 'dsh-bio-genie', 'python-env')
  const exe = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
  return existsSync(exe) ? exe : null
}

/** 权威真值：逐包真实 `import X`（慢但无歧义），仅用于交叉校验。 */
function importTruth(exe, importNames) {
  const out = {}
  for (const m of importNames) {
    const r = spawnSync(exe, ['-I', '-c', `import ${m}`], { encoding: 'utf8', timeout: 120_000 })
    out[m] = r.status === 0
  }
  return out
}

const py = findPython()
if (!py) {
  console.log('SKIP 插件 venv 未引导（~/.dsh/dsh-bio-genie/python-env 不存在）——先调用一次 bio_python 触发自举')
  process.exit(0)
}

const ADDONS = ['circuit-modeling', 'sbol-standard', 'single-cell', 'crispr-ngs']

// ---- 1. 面板加载耗时：等价于 GET /addons 的全部状态探测必须 < 2.5s（旧实现 ~5.9s）----
{
  const hasBatch = typeof runtime.addonsStatus === 'function'
  assert(hasBatch, 'runtime.js 导出批量 addonsStatus(exe)')
  const t0 = Date.now()
  let modules
  if (hasBatch) {
    modules = await runtime.addonsStatus(py)
  } else {
    modules = {}
    for (const k of ADDONS) {
      const st = await runtime.manageAddon(k, 'status', py)
      if (st.ok) modules[k] = { installed: st.installed, packages: st.packages }
    }
  }
  const ms = Date.now() - t0
  assert(ms < 2500, `全部模块状态探测耗时 ${ms}ms < 2500ms`)
  for (const k of ADDONS) {
    const m = modules[k]
    assert(m && typeof m.installed === 'boolean', `模块 ${k} 返回 installed 布尔值`)
    assert(Array.isArray(m?.packages) && m.packages.every((p) => typeof p.package === 'string' && typeof p.installed === 'boolean'),
      `模块 ${k} 每个包都有 {package, installed}`)
  }
}

// ---- 2. 判定正确性：与真实 import 结果交叉校验（一个全装模块 + 一个缺包模块）----
{
  const modsMeta = (await runtime.addonsStatus(py))
  for (const key of ['circuit-modeling', 'crispr-ngs']) {
    const names = modsMeta[key].packages.map((p) => {
      const pkg = p.package
      return ({ 'python-libsbml': 'libsbml' })[pkg] ?? pkg.replace(/-/g, '_')
    })
    const truth = importTruth(py, names)
    const got = Object.fromEntries(modsMeta[key].packages.map((p) => [
      ({ 'python-libsbml': 'libsbml' })[p.package] ?? p.package.replace(/-/g, '_'), p.installed]))
    for (const n of names) {
      assert(got[n] === truth[n], `${key}/${n}: 元数据判定(${got[n]}) === 真实 import(${truth[n]})`)
    }
  }
}

// ---- 3. manageAddon 单模块 status 行为保持（install/uninstall 复用同一探测）----
{
  const st = await runtime.manageAddon('crispr-ngs', 'status', py)
  assert(st.ok === true && Array.isArray(st.packages) && st.packages.length === 1,
    "manageAddon('crispr-ngs','status') 返回 ok + 单包明细")
  const bad = await runtime.manageAddon('no-such-module', 'status', py)
  assert(bad.ok === false, '未知模块返回 ok:false')
}

process.exit(failures > 0 ? 1 : 0)
