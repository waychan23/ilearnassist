/**
 * Simplified Chinese — the source of truth for the catalog schema.
 *
 * `en.ts` is typed as `typeof` this object, so a key added here and forgotten there is a
 * `vue-tsc` error (`pnpm typecheck`). The reverse direction — a key in `en` that is not
 * here — is caught by `test/i18n/catalog.test.ts`, which also checks placeholder parity.
 *
 * Key paths are **domain-first** (`chat.titleHint`, `tools.name.write_file`), never keyed
 * by the component file that happens to use them: components get split and renamed, and a
 * file-keyed catalog turns every refactor into a catalog migration.
 *
 * Two message-syntax traps, both of which fail *silently*:
 *   - `|` separates plural branches. A literal `|` in a message must be escaped `{'|'}`.
 *   - `{` `}` open an interpolation. A literal brace must be escaped `{'{'}` / `{'}'}`.
 * Chinese punctuation (`（）` `「」` `·`) needs no escaping, so this catalog is unaffected
 * so far — but keep the rule in mind for a message that quotes code or a template.
 *
 * Plural is a *catalog* concern, not a call-site concern: `en` messages use `|` branches,
 * `zh` messages never do, and both are called as `t(key, count, { …params })`.
 */
export default {
  common: {
    confirmTitle: "确认操作",
    confirm: "确认",
    cancel: "取消",
    create: "创建",
    delete: "删除",
    name: "名称",
  },

  app: {
    /** Shown when there is no session and no workspace to name the topbar after. */
    title: "guided-learning",
    configBanner: {
      before: "⚠ 尚未配置可用的 API Key。点击右上角",
      action: "⚙ 设置 → Providers",
      after: "添加一个 Provider 并填入 Key，保存后即刻生效。",
    },
  },

  /**
   * Autonyms, deliberately untranslated in both catalogs: a language picker that says
   * "Chinese" to someone who reads no English is useless. `locale.zhCN` is the single
   * legitimate CJK value in `en.ts`, and the catalog test allowlists it.
   */
  locale: {
    switchLabel: "语言",
    zhCN: "中文",
    en: "English",
  },

  theme: {
    light: "浅色",
    dark: "深色",
    auto: "自动",
    /** Reads clearer than a bare "自动" when the OS is doing the deciding. */
    autoCurrent: "自动（当前{current}）",
    toggleTitle: "主题：{label}（点击切换）",
  },

  chat: {
    titleHint: "标题由 AI 自动生成，修改后将不再自动更新",
    titlePlaceholder: "会话标题",
    editTitleHint: "点击编辑标题",
    editTitle: "编辑标题",
    autoBadgeTitle: "标题由 AI 根据第一轮对话自动生成",
    start: "开始对话",
    startHint: "在下方输入消息，Agent 将按需调用工具。",
    startAction: "＋ 新建会话（选择 Copilot）",
  },

  composer: {
    parsing: "正在解析附件，完成后即可发送…",
    parseFailed:
      "有 {count} 个附件解析失败，模型将无法读取其内容。可点击附件上的 ↻ 重新解析，或先在「设置 → 文档解析」中配置云解析服务。",
    visionWarning:
      "当前模型「{model}」未标记支持图片输入，图片将以文字占位符发送。可在「设置 → Providers」中为它勾选「图片输入」。",
    placeholder: "输入消息，Enter 发送，Shift+Enter 换行",
    thinking: "Agent 正在思考…",
    parsingShort: "附件解析中…",
    send: "发送 (Enter)",
    attach: "添加图片或文件",
    settings: "会话参数（Temperature、上下文长度、工具轮数…）",
  },

  attachments: {
    parsing: "解析中…",
    parsingTitle: "正在提取文本，完成后才能发送",
    ready: "已解析",
    readyTitle: "已解析，内容会随消息一起发送",
    failed: "解析失败",
    chars: "{count} 字符",
    charsK: "{count}k 字符",
    pages: "{count} 页",
    cloud: "云解析",
    reparse: "重新解析",
    remove: "移除",
    tooLarge: "「{name}」超过 {limitMb} MB 限制",
  },

  minimap: {
    image: "[图片]",
    file: "[附件：{name}]",
    empty: "（无文本内容）",
    jumpTo: "跳转到第 {n} 轮对话",
  },

  sidebar: {
    newWorkspace: "新建工作区",
    deleteWorkspace: "删除当前工作区",
    sessions: "会话",
    newSession: "新建会话",
    renameHint: "双击重命名",
    rename: "重命名",
    delete: "删除",
    noSessions: "暂无会话",
    settings: "设置",
  },

  session: {
    /** Shown in place of a title before the auto-titler has produced one. */
    fallbackTitle: "新会话",
    new: {
      title: "新建会话",
      titleLabel: "标题（可选）",
      titlePlaceholder: "留空则为「{fallback}」",
      noCopilot: "不使用 Copilot",
      noCopilotDesc: "使用内置的通用助手设定与默认参数。",
      noCopilots: "还没有 Copilot。可在「设置 → Copilots」中创建。",
    },
    delete: {
      title: "删除会话",
      message: "确定删除会话「{name}」吗？",
      detail: "该会话的全部消息记录将一并删除，且无法恢复。",
    },
  },

  workspace: {
    new: {
      title: "新建工作区",
      namePlaceholder: "例如：My Project",
      hint: "将在工作区根目录自动创建对应的子目录。",
    },
    delete: {
      title: "删除工作区",
      message: "确定删除工作区「{name}」吗？",
      detail: "{path} 目录及其中所有文件都会被删除，且无法恢复。",
    },
  },

  /**
   * One message per `ApiErrorCode`. The catalog test iterates the shared union, so a code
   * added there without a message here fails the suite.
   */
  errors: {
    NAME_REQUIRED: "名称不能为空。",
    WORKSPACE_NOT_FOUND: "工作区不存在，可能已被删除。",
    COPILOT_NOT_FOUND: "Copilot 不存在，可能已被删除。",
    SESSION_NOT_FOUND: "会话不存在，可能已被删除。",
    TITLE_EMPTY: "标题不能为空。",
    UNSUPPORTED_FILE_TYPE: "不支持该文件类型：{mimeType}",
    INVALID_ATTACHMENT_PATH: "附件路径无效。",
    ATTACHMENT_NOT_FOUND: "附件不存在，可能已被删除。",
    ATTACHMENT_STORE_FAILED: "附件保存失败，请重试。",
    DATA_REQUIRED: "缺少文件内容。",
    INVALID_BASE64: "文件内容不是合法的 base64 编码。",
    EMPTY_FILE: "文件是空的。",
    FILE_TOO_LARGE: "文件超过 {limitMb} MB 限制。",
    PROVIDER_NOT_FOUND: "Provider 不存在，可能已被删除。",
    MODEL_NOT_FOUND: "模型不存在或已被移除。",
    MODEL_ID_REQUIRED: "每个模型都需要填写 modelId。",
    BASE_URL_REQUIRED: "Base URL 不能为空。",
    ONLY_PROVIDER: "不能删除唯一的 Provider。",
    DEFAULT_PROVIDER: "这是默认 Provider，请先选择另一个默认 Provider。",
    PARSER_NOT_FOUND: "解析服务不存在，可能已被删除。",
    UNKNOWN_PARSER_KIND: "未知的解析服务类型：{kind}",
    UNKNOWN_POLICY: "未知的解析策略：{policy}",
    UNKNOWN_PARSER: "未知的解析服务。",
    UNKNOWN_PROVIDER: "未知的 Provider。",
    MESSAGE_REQUIRED: "消息内容不能为空。",
  },

  /**
   * One message per `ParseErrorCode`. `{detail}` is only present for `cloud_failed` and
   * `corrupt` — the two codes whose sentence cannot stand without the provider's words.
   */
  parseErrors: {
    password_protected: "文件已加密，需要密码才能读取内容。",
    no_text_layer: "未检测到文本层，可能是扫描件或纯图片 PDF。可配置支持 OCR 的云解析服务后重试。",
    too_large: "文件超过本地解析上限，已跳过解析。可配置云解析服务后重试，或开启更高上限。",
    unsupported_type: "暂不支持解析该文件类型。",
    corrupt: "文件无法读取：{detail}",
    missing_file: "文件已丢失，无法解析。请重新上传。",
    no_cloud_parser: "没有可用的云解析服务。请到「设置 → 文档解析」添加一个并启用。",
    local_disabled: "本地解析已在设置中关闭。",
    cloud_auth: "云解析服务拒绝了凭据，请检查 API Key。",
    cloud_failed: "云解析失败：{detail}",
    timeout: "解析超时。文件可能过大，或解析服务无响应。",
    cancelled: "解析已取消。",
  },
};
