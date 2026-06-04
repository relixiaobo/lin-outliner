import type { PartialMessages } from '../types';

// Simplified Chinese. A deep-partial of English (core/i18n/messages/en.ts): any key
// omitted here renders in English until translated. "Tenon" is a brand name and is
// kept verbatim (not transliterated). Keep this file's shape a strict subset of
// en.ts — the coverage test (test/core/i18n-coverage) reports any drift.

export const zhHans: PartialMessages = {
  menu: {
    settings: '设置…',
    about: ({ app }) => `关于 ${app}`,
    hide: ({ app }) => `隐藏 ${app}`,
    quit: ({ app }) => `退出 ${app}`,
    file: '文件',
    view: '视图',
    help: ({ app }) => `${app} 帮助`,
    reportIssue: '报告问题…',
    addToDictionary: '添加到词典',
  },
  window: {
    settingsTitle: ({ app }) => `${app} 设置`,
  },
  launcher: {
    placeholder: '捕获、搜索或运行命令…',
    queryAriaLabel: '启动器查询',
    rootAriaLabel: ({ app }) => `${app} 启动器`,
    resultsAriaLabel: '结果',
  },
  settings: {
    railTitle: '设置',
    loading: '加载中…',
    categoriesAriaLabel: '设置分类',
    categories: {
      general: { label: '通用', hint: '外观与主题' },
      providers: { label: '提供方', hint: '连接与 API 密钥' },
      permissions: { label: '权限', hint: '工具允许 / 询问规则' },
      skills: { label: '技能', hint: '扩展能力' },
      agents: { label: '智能体配置', hint: '人格定义' },
    },
    general: {
      intro: '外观与全局偏好设置。',
      appearanceGroup: '外观',
      themeLabel: '主题',
      themeSublabel: '跟随系统外观，或始终使用浅色 / 深色。',
      themeSystem: '系统',
      themeLight: '浅色',
      themeDark: '深色',
      languageLabel: '语言',
      languageSublabel: '选择菜单和界面的显示语言。',
    },
  },
  common: {
    untitled: '未命名',
    loading: '加载中…',
  },
  shell: {
    startupError: ({ error }) => `启动失败：${error}`,
    errorDismiss: '关闭错误',
    sidebar: {
      ariaLabel: '主导航',
      primaryNav: {
        today: '今天',
        library: '资料库',
        recents: '最近',
        schema: '结构',
      },
      collapseNode: ({ label }) => `折叠 ${label}`,
      expandNode: ({ label }) => `展开 ${label}`,
      pinnedSection: '已固定',
      noPinnedHint: '拖拽以固定节点',
      pinnedNodesAriaLabel: '已固定节点',
      openRoot: ({ rootLabel }) => `打开 ${rootLabel}`,
      workspaceRootTreeAriaLabel: '工作区根节点树',
      settings: '设置',
      resizeLabel: '调整侧栏宽度',
      resizeTitle: '调整侧栏宽度（双击重置）',
      missingReference: '引用缺失',
    },
    chrome: {
      collapseSidebar: '收起侧栏',
      expandSidebar: '展开侧栏',
      collapseAgent: '收起智能体',
      expandAgent: '展开智能体',
    },
    workspace: {
      canvasAriaLabel: '工作区画布',
      resizePanelsLabel: '调整面板宽度',
      resizePanelsTitle: '调整面板宽度（双击重置）',
    },
    panel: {
      closeLabel: '关闭面板',
    },
    agentDock: {
      ariaLabel: '智能体',
      resizeLabel: '调整智能体宽度',
      resizeTitle: '调整智能体宽度（双击重置）',
    },
  },
};
