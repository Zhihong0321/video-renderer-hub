/**
 * Tiny i18n for the studio. No build step, no framework.
 *
 * Usage:
 *   import { t, setLocale, getLocale, AVAILABLE_LOCALES } from './i18n.js';
 *   t('toolbar.export_mp4')
 *   setLocale('zh')
 *
 * Locale resolution order:
 *   1. localStorage hv.studio.locale
 *   2. navigator.language prefix ("zh-CN" → "zh")
 *   3. DEFAULT_LOCALE = "en"
 *
 * Strings missing in the active locale fall back to en, then the key.
 */

export const DEFAULT_LOCALE = 'en';
export const AVAILABLE_LOCALES = ['en', 'zh'];

const DICT = {
  en: {
    'app.empty_pick_create': 'Pick or create a project',
    'app.empty_subtitle':
      'Each project = one HTML video. Choose a template to see the visual baseline, chat with your agent to drive the content, edit per-frame text in the middle column, see the result on the right.',
    'app.no_project': 'no project',

    'sidebar.projects': 'Projects',
    'sidebar.new': '+ New',
    'sidebar.collapse': 'Collapse sidebar',
    'sidebar.empty_list': 'no projects yet',
    'sidebar.menu.rename': '✎ Rename',
    'sidebar.menu.delete': '🗑 Delete',
    'sidebar.rename_prompt': 'New project name',
    'sidebar.delete_confirm': 'Delete "{name}"? This cannot be undone.',

    'toolbar.template': 'Template',
    'toolbar.template_pick': 'Optional · Pick template',
    'toolbar.agent': 'Agent',
    'toolbar.agent_none': '— none —',
    'toolbar.agent_ready': '● ready',
    'toolbar.agent_install': '○ install',
    'toolbar.export_mp4': 'Export MP4',

    'composer.placeholder.no_project': 'Pick a project first…',
    'composer.placeholder.detecting_agents': 'Describe the video while we check for agents…',
    'composer.placeholder.no_agent': 'Install Claude Code (claude CLI) to enable chat…',
    'composer.placeholder.focus':
      'Edit only this frame (click ✕ on the chip above to release)…',
    'composer.placeholder.no_template':
      'Describe a video — style, content, mood. Or pick a template above for a quick start.',
    'composer.placeholder.with_template': 'Describe the video — content, names, data, mood…',
    'composer.hint': 'Cmd / Ctrl + Enter · drag / paste files',
    'composer.send': 'Send',
    'composer.attach': 'Attach file',
    'composer.focus_chip': 'Editing only frame {order} {fid}',
    'composer.focus_clear': 'Clear focus',

    'chat.empty.title': 'Send a message to start',
    'chat.empty.body':
      'Tell the agent what you want — a single brand card, a multi-frame teaser, a data poster — and it will scaffold the HTML.',
    'chat.summary.form_submitted': '📋 Form submitted',
    'chat.summary.confirm_generate': '✓ Generate',
    'chat.summary.confirm_edit': '✏️ Edit',
    'chat.thinking': 'agent thinking',
    'chat.placeholder.gen_html': '📄 *generating HTML…*',
    'chat.placeholder.plan_graph': '🧭 *planning storyboard…*',
    'chat.empty_reply':
      '⚠️ The agent returned an empty reply. Try rephrasing your request — e.g. tell it the brand / topic / 1-2 concrete details, or which kind of frame you want first.',

    'preview.placeholder.pick_project': 'Pick a project first.',
    'preview.placeholder.pick_template':
      'Send a chat to generate the first HTML.<br>Or pick a template up top for a quick start.',
    'preview.edit_text_on': '✓ Done editing',
    'preview.edit_text_off': '✎ Edit text',
    'preview.edit_text_title': 'Click any text in the preview to edit',
    'preview.edit_text_done_title': 'Finish editing',
    'preview.reload': '↻ Reload preview',
    'preview.no_hv_text':
      'This frame has no editable text (HTML missing data-hv-text).',

    'frames.label': 'Frames',
    'frames.view_graph': 'View graph',

    'text_pane.title': 'Frame text',
    'text_pane.no_project': 'No project.',
    'text_pane.empty_with_frames':
      'No editable text on this frame. Switch to another frame, or click ✎ Edit text on the canvas.',
    'text_pane.empty_no_frames':
      'No editable text yet. Send a chat to generate the first version of the HTML, then per-frame text fields appear here.',
    'text_pane.collapse': 'Collapse panel',
    'text_pane.save_state.idle': '—',
    'text_pane.save_state.typing': 'typing…',
    'text_pane.save_state.saving': 'saving…',
    'text_pane.save_state.saved': 'saved',
    'text_pane.save_state.error': 'error',

    'export.starting': '⏵ Starting MP4 export…',
    'export.button_running': '⏵ {pct}% · {stage}',
    'export.done_seconds': '✓ MP4 exported · {seconds}',
    'export.done_no_seconds': '✓ MP4 exported',
    'export.failed': '⚠️ Export failed: {message}',
    'export.stream_interrupted': 'Export stream interrupted: {message}',
    'export.failed_short': 'Export failed: {message}',
    'export.title': '🎬 MP4 ready',
    'export.reveal': 'Reveal in Finder',
    'export.copy_path': 'Copy path',
    'export.copied': 'Path copied',
    'export.copy_failed': 'Copy failed: {message}',
    'export.reveal_failed': 'Open failed: {message}',

    'graph.title': 'Content graph',
    'graph.download': '⬇ Download JSON',
    'graph.close': '✕',
    'graph.empty': '(no graph for this project)',
    'graph.error': 'error loading graph: {message}',

    'gallery.title': 'Pick a template',
    'gallery.close': '✕',

    'modal.new.title': 'New project',
    'modal.new.name_label': 'Name',
    'modal.new.name_placeholder': 'e.g. nexu-io launch teaser',
    'modal.new.intent_label': 'Intent (optional)',
    'modal.new.intent_placeholder': 'A one-line description of what this video is about',
    'modal.new.cancel': 'Cancel',
    'modal.new.create': 'Create',
    'modal.new.name_required': 'Name is required',
    'modal.new.created': 'Created "{name}"',
    'modal.new.failed': 'Failed to create project',

    'language.label': 'Language',

    'settings.title': 'Settings',
    'settings.tab.agent': 'Agent',
    'settings.tab.language': 'Language',
    'settings.tab.about': 'About',

    'settings.agent.title': 'Agent',
    'settings.agent.subtitle': 'Pick the runtime that turns your chat into HTML.',
    'settings.agent.mode.local': 'Local CLI',
    'settings.agent.mode.byok': 'BYOK (API)',
    'settings.agent.detected': 'Detected agents ({count})',
    'settings.agent.test': 'Test',
    'settings.agent.testing': 'Testing…',
    'settings.agent.test_ok': 'OK · {ms}ms · {bytes}B',
    'settings.agent.test_fail': 'Failed: {message}',
    'settings.agent.empty_reply': 'Failed: agent returned an empty reply',
    'settings.agent.use': 'Use',
    'settings.agent.in_use': 'In use',
    'settings.agent.unavailable': 'Not installed',
    'settings.agent.byok.intro': 'Use your own Anthropic / OpenRouter API key. Reads from environment:',
    'settings.agent.byok.env_key': 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN',
    'settings.agent.byok.env_base': 'ANTHROPIC_BASE_URL (optional, defaults to api.anthropic.com)',
    'settings.agent.rescan': '↻ Rescan',
    'settings.agent.rescanned': 'Rescanned',

    'settings.language.title': 'Language',
    'settings.language.subtitle': 'Studio interface language. Re-renders instantly.',
    'settings.language.en': 'English',
    'settings.language.zh': '中文',
    'settings.language.en_sub': 'EN',
    'settings.language.zh_sub': 'ZH-CN',

    'settings.about.title': 'About',
    'settings.about.subtitle': 'html-video — open-source HTML→Video meta-layer for coding agents.',
    'settings.about.version': 'Version',
    'settings.about.repo': 'Repo',
    'settings.about.discord': 'Discord',
    'settings.about.license': 'License',
    'settings.about.related': 'Related',

    'toolbar.settings': 'Settings',
  },

  zh: {
    'app.empty_pick_create': '挑一个项目或新建',
    'app.empty_subtitle':
      '每个项目 = 一个 HTML 视频。挑一个模板看视觉基线、跟 agent 聊驱动内容、在中间栏改逐帧文字、右边看效果。',
    'app.no_project': '未选项目',

    'sidebar.projects': '项目',
    'sidebar.new': '+ 新建',
    'sidebar.collapse': '收起侧栏',
    'sidebar.empty_list': '还没有项目',
    'sidebar.menu.rename': '✎ 重命名',
    'sidebar.menu.delete': '🗑 删除',
    'sidebar.rename_prompt': '新项目名',
    'sidebar.delete_confirm': '删除 "{name}"？此操作不可撤销。',

    'toolbar.template': '模板',
    'toolbar.template_pick': '可选 · 挑模板',
    'toolbar.agent': 'Agent',
    'toolbar.agent_none': '— 无 —',
    'toolbar.agent_ready': '● 就绪',
    'toolbar.agent_install': '○ 待装',
    'toolbar.export_mp4': '导出 MP4',

    'composer.placeholder.no_project': '先选一个项目…',
    'composer.placeholder.detecting_agents': '描述视频（正在探测 agent）…',
    'composer.placeholder.no_agent': '装 claude CLI 后即可聊天…',
    'composer.placeholder.focus': '只修改这一帧的内容（点掉上方芯片可恢复整片）…',
    'composer.placeholder.no_template': '描述视频 — 风格、内容、氛围。或上方挑一个模板快开。',
    'composer.placeholder.with_template': '描述视频 — 内容、名字、数据、氛围…',
    'composer.hint': 'Cmd / Ctrl + Enter · 拖拽 / 粘贴文件',
    'composer.send': '发送',
    'composer.attach': '附加文件',
    'composer.focus_chip': '仅修改第 {order} 帧 {fid}',
    'composer.focus_clear': '清除',

    'chat.empty.title': '发条消息开始',
    'chat.empty.body':
      '告诉 agent 想做什么 — 单帧标题卡、多帧预告片、数据大字报 — 它会搭出 HTML。',
    'chat.summary.form_submitted': '📋 提交了表单',
    'chat.summary.confirm_generate': '✓ 确认生成',
    'chat.summary.confirm_edit': '✏️ 改一下',
    'chat.thinking': 'agent 思考中',
    'chat.placeholder.gen_html': '📄 *正在生成 HTML…*',
    'chat.placeholder.plan_graph': '🧭 *规划故事板…*',
    'chat.empty_reply':
      '⚠️ Agent 返回为空。试着重新表述 — 比如告诉它品牌 / 主题 / 1-2 个具体点，或者你想要什么类型的帧。',

    'preview.placeholder.pick_project': '先选一个项目。',
    'preview.placeholder.pick_template':
      '发一条消息让 agent 生成第一版 HTML。<br>或上方挑一个模板快开。',
    'preview.edit_text_on': '✓ 完成编辑',
    'preview.edit_text_off': '✎ 编辑文字',
    'preview.edit_text_title': '点画面里的文字直接修改',
    'preview.edit_text_done_title': '完成编辑',
    'preview.reload': '↻ 重载预览',
    'preview.no_hv_text': '当前帧没有可编辑的文字（HTML 缺 data-hv-text 标签）。',

    'frames.label': '分镜',
    'frames.view_graph': '看图谱',

    'text_pane.title': '帧文字',
    'text_pane.no_project': '无项目。',
    'text_pane.empty_with_frames':
      '当前帧没有可编辑文字。切到别的帧，或在画面里点 ✎ 编辑文字。',
    'text_pane.empty_no_frames':
      '还没有可编辑的字段。发一条消息生成第一版 HTML，逐帧字段会出现在这里。',
    'text_pane.collapse': '收起面板',
    'text_pane.save_state.idle': '—',
    'text_pane.save_state.typing': '输入中…',
    'text_pane.save_state.saving': '保存中…',
    'text_pane.save_state.saved': '已保存',
    'text_pane.save_state.error': '错误',

    'export.starting': '⏵ 开始导出 MP4…',
    'export.button_running': '⏵ {pct}% · {stage}',
    'export.done_seconds': '✓ MP4 已导出 · {seconds}',
    'export.done_no_seconds': '✓ MP4 已导出',
    'export.failed': '⚠️ 导出失败：{message}',
    'export.stream_interrupted': '导出流中断：{message}',
    'export.failed_short': '导出失败：{message}',
    'export.title': '🎬 MP4 已就绪',
    'export.reveal': '在 Finder 中显示',
    'export.copy_path': '复制路径',
    'export.copied': '已复制路径',
    'export.copy_failed': '复制失败：{message}',
    'export.reveal_failed': '打开失败：{message}',

    'graph.title': '内容图谱',
    'graph.download': '⬇ 下载 JSON',
    'graph.close': '✕',
    'graph.empty': '（项目没有图谱）',
    'graph.error': '加载图谱失败：{message}',

    'gallery.title': '挑一个模板',
    'gallery.close': '✕',

    'modal.new.title': '新建项目',
    'modal.new.name_label': '名称',
    'modal.new.name_placeholder': '例如：nexu-io 发布预告',
    'modal.new.intent_label': '意图（可选）',
    'modal.new.intent_placeholder': '一句话说说这个视频在讲什么',
    'modal.new.cancel': '取消',
    'modal.new.create': '创建',
    'modal.new.name_required': '名称不能空',
    'modal.new.created': '已创建 "{name}"',
    'modal.new.failed': '创建项目失败',

    'language.label': '语言',

    'settings.title': '设置',
    'settings.tab.agent': 'Agent',
    'settings.tab.language': '界面语言',
    'settings.tab.about': '关于',

    'settings.agent.title': 'Agent',
    'settings.agent.subtitle': '选一个运行时把你的对话翻成 HTML。',
    'settings.agent.mode.local': '本机 CLI',
    'settings.agent.mode.byok': 'BYOK (API)',
    'settings.agent.detected': '已检测到的 agent（{count}）',
    'settings.agent.test': '测试',
    'settings.agent.testing': '测试中…',
    'settings.agent.test_ok': '通过 · {ms}ms · {bytes}B',
    'settings.agent.test_fail': '失败：{message}',
    'settings.agent.empty_reply': '失败：agent 返回为空',
    'settings.agent.use': '使用',
    'settings.agent.in_use': '当前',
    'settings.agent.unavailable': '未安装',
    'settings.agent.byok.intro': '直连 Anthropic / OpenRouter API。从环境变量读：',
    'settings.agent.byok.env_key': 'ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN',
    'settings.agent.byok.env_base': 'ANTHROPIC_BASE_URL（可选，默认 api.anthropic.com）',
    'settings.agent.rescan': '↻ 重新扫描',
    'settings.agent.rescanned': '已重新扫描',

    'settings.language.title': '界面语言',
    'settings.language.subtitle': 'Studio 界面语言，切换立即生效。',
    'settings.language.en': 'English',
    'settings.language.zh': '中文',
    'settings.language.en_sub': 'EN',
    'settings.language.zh_sub': 'ZH-CN',

    'settings.about.title': '关于',
    'settings.about.subtitle': 'html-video — 开源的 HTML→视频 meta-layer，为 coding agent 设计。',
    'settings.about.version': '版本',
    'settings.about.repo': '代码仓库',
    'settings.about.discord': 'Discord',
    'settings.about.license': '许可',
    'settings.about.related': '相关项目',

    'toolbar.settings': '设置',
  },
};

const STORAGE_KEY = 'hv.studio.locale';
let _locale = resolveInitialLocale();

function resolveInitialLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && AVAILABLE_LOCALES.includes(stored)) return stored;
  } catch {
    /* localStorage unavailable */
  }
  // Default is English regardless of nav.language. Joey explicitly asked.
  return DEFAULT_LOCALE;
}

export function getLocale() {
  return _locale;
}

export function setLocale(loc) {
  if (!AVAILABLE_LOCALES.includes(loc)) return;
  _locale = loc;
  try { localStorage.setItem(STORAGE_KEY, loc); } catch {}
  // Notify listeners (the studio app re-renders).
  document.dispatchEvent(new CustomEvent('hv-locale-change', { detail: { locale: loc } }));
}

/**
 * Apply i18n to static DOM elements. Markers:
 *   data-i18n="key"          → textContent
 *   data-i18n-attr="placeholder:key,title:key2"  → set those attrs
 *   data-i18n-html="key"     → innerHTML (caution: only for trusted keys)
 *
 * Call once after DOMContentLoaded and also on every locale change.
 */
export function applyDomI18n(root) {
  const r = root || document;
  r.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  r.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  r.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const pairs = (el.dataset.i18nAttr || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
}

document.addEventListener('hv-locale-change', () => applyDomI18n());
document.addEventListener('DOMContentLoaded', () => applyDomI18n());

/**
 * Translate a key. `params` is a plain object whose keys substitute
 * `{key}` placeholders in the resolved string.
 */
export function t(key, params) {
  const dict = DICT[_locale] ?? DICT[DEFAULT_LOCALE];
  let s = dict[key];
  if (s === undefined) {
    // Fall back to English, then to the key itself.
    s = DICT[DEFAULT_LOCALE][key] ?? key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
