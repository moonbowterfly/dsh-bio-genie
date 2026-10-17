/**
 * venv python spawn 的隔离环境小工具（测试共用）。
 *
 * 背景（2026-10-17 实测）：Hermes agent 宿主 shell 会注入
 * PYTHONPATH=<hermes 工具 venv 的 site-packages>。venv python 若被直连
 * spawn（不带 -I），该路径排在 sys.path 最前，会影子化 venv 内同名包——
 * 实测影子 jsonschema（design 双端等价性假红 16/28）与 PIL（_imaging
 * 导入崩溃）。生产侧 src/python.js 已用「-I + 清空 PYTHONPATH/PYTHONHOME」
 * 双保险；测试/脚本的直连 spawn 一律经本函数取环境。
 *
 * 例外：design-offline 的哨兵预载场景自行整体替换 PYTHONPATH（替换非合并，
 * 天然免疫），不属于此列，勿改。
 */
export function cleanVenvEnv(base = process.env) {
  const env = { ...base }
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  return env
}
