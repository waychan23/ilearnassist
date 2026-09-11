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
    copied: "已复制",
    copy: "复制",
    save: "保存",
    close: "关闭",
    edit: "编辑",
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
  tools: {
    name: {
      web_search: "网页搜索",
      web_fetch: "读取网页",
      list_files: "列出文件",
      read_file: "读取文件",
      write_file: "写入文件",
      create_directory: "创建目录",
      delete_file: "删除文件",
      read_document: "读取文档",
    },
    done: "完成",
    running: "运行中",
    args: "参数",
    result: "结果",
  },

  message: {
    copyReply: "复制回复",
    contextTokens: "本轮上下文 {count} tokens",
    usage: {
      input: "输入",
      output: "输出",
      total: "合计",
      cached: "缓存命中",
    },
    reasoning: {
      thinking: "思考中",
      done: "已深度思考",
      duration: "用时 {duration}",
      copy: "复制思考内容",
    },
  },

  tokens: {
    used: "已用上下文",
    pending: "待发送输入（估算）",
    projected: "预计占用",
    estimatedLimit: "估算上限",
    limitHint: "模型未配置上下文长度，使用默认估算值",
    messages: "上下文消息",
    maxSteps: "最大工具轮数",
    note: "「已用上下文」来自上一轮的 token 统计；「待发送输入」按字符数估算，仅供预览。",
  },

  copilot: {
    edit: "编辑 Copilot",
    create: "新建 Copilot",
    namePlaceholder: "例如：代码助手",
    description: "描述",
    descriptionPlaceholder: "一句话说明它的用途",
    systemPrompt: "System Prompt（设定）",
    systemPromptPlaceholder: "定义这个 Copilot 的角色、能力与行为约束…",
    systemPromptHint: "留空则使用内置的通用助手设定。",
    tools: "可用工具（留空 = 全部可用）",
    defaults: "默认参数（新建会话时复制到会话中，之后可在会话里单独调整）",
    inherit: "继承默认",
    model: "模型",
    maxOutput: "最大输出",
    unitToken: "单位 token",
    maxHistory: "最多携带历史消息",
    all: "全部",
    unitMessages: "单位「条」",
    maxSteps: "最大工具轮数",
    unitSteps: "单位「轮」",
  },


  settings: {
    title: "设置",
    tabs: {
      providers: "Providers / 模型",
      documents: "文档解析",
      copilot: "默认与工具",
    },
    providers: {
      countConfigured: "已配置 {count} 个 Provider",
      add: "＋ 新建 Provider",
      default: "默认",
      keySet: "✓ Key 已配置",
      keyMissing: "✗ 未配置 Key",
      deleteModel: "删除该模型",
      noModels: "尚未配置模型",
      empty: "还没有 Provider，点击「新建 Provider」添加一个 OpenAI 兼容的接口。",
      visionHint: "支持图片输入",
      reasoningHint: "推理模型",
      /* Split around the markup rather than shipping HTML in a message: the two
         emphasised fragments map onto <strong> and <code> in the template. */
      noteBefore: "Provider 与模型保存在数据库中，配置",
      noteLive: "即时生效",
      noteBetween: "，无需重启服务。",
      noteConfigFile: "config.yaml",
      noteAfter: " 仅作为首次启动的初始数据。API Key 只写不读回。",
    },
    documents: {
      introBefore: "PDF、Word、Excel、PowerPoint 附件会先转成文本再交给模型。本地解析",
      introBuiltin: "开箱即用",
      introAfter:
        "，云解析服务是可选补充 —— 扫描件、复杂排版、公式表格这些本地读不出来的，交给它更合适。",
      policy: "解析策略",
      localEnabled: "启用本地解析",
      localHint: "关闭后只能依赖云解析服务。只有在策略为「仅云」，或已经配好云服务时才建议关闭。",
      fallback: "允许回退到另一侧",
      fallbackHint:
        "关闭后，选定的那一侧失败就直接报错，不再尝试另一侧。适用于想严格控制外发的场景。",
      cloudParsers: "云解析服务",
      addParser: "＋ 添加服务",
      noParsers: "还没有配置云解析服务。本地解析仍然可用，扫描件会因此解析失败。",
      enabled: "已启用",
      disabled: "已停用",
      keySet: "Key 已配置",
      testing: "测试中…",
      test: "测试连接",
      testOk: "连接正常",
    },
    copilot: {
      countConfigured: "已配置 {count} 个 Copilot",
      add: "＋ 新建 Copilot",
      inUse: "当前会话使用中",
      empty: "还没有 Copilot，点击「新建 Copilot」创建一个。",
      introBefore:
        "Copilot 定义一段系统设定（System Prompt）、可用工具与默认生成参数。新建会话时选择一个 Copilot，它的设定会注入该对话，默认参数会被",
      introCopied: "复制",
      introAfter: "到会话中 —— 之后修改 Copilot 不会影响已开始的对话。",
      summarySteps: "最多 {count} 轮工具",
      summaryHistory: "历史 {count} 条",
      summaryTools: "{count} 个工具",
      summaryAllTools: "全部工具",
    },
    defaults: {
      provider: "默认 Provider",
      providerHint: "新建会话未指定 Provider 时使用。当前：{name}",
      model: "默认模型",
      modelHint: "新建会话未指定模型时使用。当前：{name}",
      modelUnset: "未设置",
      workspaceRoot: "工作区根目录",
      webSearch: "网页搜索 Provider",
      webSearchHint: "（在 config.yaml 的 tools.webSearch 中修改）",
    },
    deleteProvider: {
      title: "删除 Provider",
      message: "确定删除「{name}」吗？",
      detail: "它的 {count} 个模型配置会一并删除，使用它的会话将回退到默认 Provider。",
    },
    deleteModel: {
      title: "删除模型",
      message: "从「{provider}」中删除模型「{model}」？",
      detail: "仍在引用它的会话会回退到该 Provider 下的第一个模型。",
    },
    deleteParser: {
      title: "删除解析服务",
      message: "确定删除「{name}」吗？",
      detail: "已经解析好的文档不受影响；重新解析时需要另选一个服务。",
    },
    deleteCopilot: {
      title: "删除 Copilot",
      message: "确定删除 Copilot「{name}」吗？",
      detail: "使用它的会话不会被删除，但会失去这层设定。",
    },
    policy: {
      "local-only": { label: "仅本地", hint: "完全离线，不调用任何外部服务" },
      "local-first": { label: "本地优先", hint: "先用本地解析，读不出内容时再调用云解析" },
      "cloud-first": { label: "云优先", hint: "先用云解析，失败时回退到本地" },
      "cloud-only": { label: "仅云", hint: "全部交给云解析服务" },
    },
  },

  providers: {
    edit: "编辑 Provider",
    create: "新建 Provider",
    namePlaceholder: "例如：DeepSeek",
    apiKeySet: "已配置（留空则不修改）",
    apiKeyUnset: "尚未配置",
    apiKeyNote: "出于安全考虑，服务端不会返回 Key 的内容。留空表示保持原值不变。",
    models: "模型",
    addModel: "＋ 添加模型",
    modelNoteBefore: "上下文长度与最大输出均以 ",
    modelNoteToken: "token",
    modelNoteAfter: " 为单位（如 128000）。上下文长度只用于估算上下文占用比例，留空则按 {fallback} 估算。",
    modelId: "模型 ID",
    displayName: "显示名称",
    displayNamePlaceholder: "留空则同模型 ID",
    contextLength: "上下文长度",
    contextWrong: "数值异常，单位是 token 不是字符",
    unitToken: "单位 token",
    maxOutput: "最大输出",
    optional: "可留空",
    removeModel: "移除模型",
    capabilities: {
      vision: "图片输入",
      reasoning: "推理模型",
      tool_use: "工具调用",
    },
  },

  modelSelector: {
    choose: "选择模型",
    chooseTitle: "选择模型（作用于当前会话）",
    noModelsTitle: "尚未配置可用的模型",
    keyMissing: "未配置 Key",
    empty: "还没有可用的模型。请在「设置 → Providers」中添加 Provider 与模型。",
    manage: "管理模型…",
  },

  parsers: {
    edit: "编辑解析服务",
    create: "新建解析服务",
    kind: "协议类型",
    kindHint:
      "协议决定怎么跟服务通信，端点与密钥由下面的字段决定。同一个协议可以建多条记录（例如 MinerU 云端与自建各一条）。",
    namePlaceholder: "例如：Docling（本机）",
    credentialsBefore: "端点需要与所选协议匹配。申请凭据：",
    apiKey: "API Key",
    apiKeyOptional: "（可选）",
    apiKeyRequired: "必填",
    apiKeyOptionalValue: "可留空",
    apiKeySet: "已配置（留空则不修改）",
    apiKeyNote: "出于安全考虑，服务端不会返回 Key 的内容。留空表示保持原值不变。",
    enabled: "启用（关闭后解析时会跳过这一条）",
  },

  sessionSettings: {
    title: "会话参数",
    scopeExisting: "这些参数只作用于当前会话。",
    scopeNew: "还没有会话，参数会应用于即将创建的新会话。",
    scopeSuffix: " 留空表示继承 Copilot 的默认值，再退回到全局默认。",
    model: "模型",
    inherit: "继承默认",
    temperatureHint: "取值范围 0 ~ 2，数值越大回答越随机。",
    topPHint: "取值范围 0 ~ 1，通常与 Temperature 二选一调节。",
    maxOutput: "最大输出",
    maxOutputHint: "单位 token，限制单次回复的最大长度。",
    maxHistory: "最多携带历史消息",
    maxHistoryAll: "全部（不截断）",
    maxHistoryHint: "单位「条」，超出时从最早的消息开始丢弃。",
    maxSteps: "最大工具轮数",
    maxStepsHint: "单位「轮」，单轮回复中最多执行多少次「模型 → 工具」循环。",
    reset: "重置",
  },

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
