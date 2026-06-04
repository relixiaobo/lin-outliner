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
};
