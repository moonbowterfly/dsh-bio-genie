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
 * 设置面板。面板内容当前为占位（用户明确：具体设置内容先不做设计）。
 *
 * 依赖仅使用静态模块表中的 seed 词（见 packages/client/web/src/seed.ts）：
 *   - 'react'                      （React 命名空间，createElement）
 *   - 'slots' 是 cordis 服务，由 @deepseek-ai/dsh-client-runtime 提供，
 *     通过 exports.inject = ['slots'] 在 fiber 层等待。
 *
 * 本文件是 classic script + CJS 闭包形态（与 @linxin666 / @deepseek-ai
 * 各客户端的 tsdown 产物同构），刻意不引入构建工具链，保持插件零构建。
 * 若后续设置面板 UI 复杂化，可平滑迁移到 tsdown 构建（src/client/*.tsx）。
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

    /**
     * 占位内容区的行内样式（保持最简：深色/浅色主题下均可用，不依赖
     * 具体 token；内容设计阶段后替换为正式的模块化样式）。
     */
    var styles = {
      section: {
        maxWidth: '64ch',
        lineHeight: 1.65,
      },
      title: {
        margin: '0 0 4px',
        fontSize: '1.05em',
      },
      intro: {
        margin: '0 0 14px',
        opacity: 0.75,
      },
      body: {
        margin: 0,
        opacity: 0.75,
      },
    }

    /**
     * settings.section 的 owner props 为 { close }；占位内容暂不使用，
     * 组件保持简单纯渲染。
     * @returns {object} 设置面板内容区的占位 ReactNode。
     */
    function BioGenieSection() {
      return createElement(
        'div',
        { className: 'biogenie-settings', style: styles.section },
        createElement('h2', { className: 'biogenie-settings-title', style: styles.title }, 'BioGenie 设置'),
        createElement('p', { className: 'biogenie-settings-intro', style: styles.intro },
          '生物信息学「许愿式分析」插件（dsh-bio-genie）的设置面板。'),
        createElement('p', { className: 'biogenie-settings-body', style: styles.body },
          '面板内容正在建设中。后续将提供：Python / R 双引擎的环境状态与引导、' +
          '执行日志回溯、记忆层管理、运行参数等配置入口。'),
      )
    }

    /**
     * 浏览器端插件入口：注册设置面板侧栏一级菜单「BioGenie」。
     * 用 slots.inject 等待设置壳（ui-settings-general）声明 settings.section
     * 槽位后再注册，保证侧栏渲染时条目已就位；槽位缺席（无设置壳的
     * 部署）时静默等待，不报错。
     * @param ctx - 浏览器 cordis 根上下文。
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
