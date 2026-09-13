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
    /**
     * Joins a list of things into one sentence: the labels a user picked, say. A separator
     * is punctuation the copy is built from, which is why it lives in the catalog rather
     * than as a `、` in a template — the English one is not the same character.
     */
    listSeparator: "、",
    save: "保存",
    close: "关闭",
    edit: "编辑",
    /*
     * Verbs and one noun that two domains now say: the sidebar acts on a conversation, the
     * workspace cards act on a workspace. Keying either copy `sidebar.*` would have put the
     * card's wording behind a key named after a component that no longer owns the idea.
     */
    rename: "重命名",
    settings: "设置",
    signOut: "退出登录",
  },

  app: {
    /**
     * The product name. Shown when there is no session and no workspace to name the topbar
     * after, and on the login screen — which is the one page with nothing else to call itself.
     */
    title: "ilearnassist",
    configBanner: {
      before: "尚未配置可用的 API Key。点击右上角",
      action: "设置 → Providers",
      after: "添加一个 Provider 并填入 Key，保存后即刻生效。",
    },
  },

  /**
   * The login screen.
   *
   * `noPassword` is not decoration: this build has no passwords, and a user who believes the
   * field in front of them is a password field will assume a privacy the app does not have.
   * Stating it is the honest half of not implementing it yet.
   */
  login: {
    lead: "输入一个用户名即可开始。",
    username: "用户名",
    usernamePlaceholder: "例如：你的名字",
    existing: "已有账号：",
    submit: "进入",
    noPassword: "这个实例没有设置密码：任何能访问这个地址的人，都可以用任意用户名进入。",
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
    startAction: "新建会话（选择 Copilot）",
    backToWorkspaces: "返回工作区列表",
    jumpToLatest: "回到最新",
  },

  composer: {
    parsing: "正在解析附件，完成后即可发送…",
    parseFailed:
      "有 {count} 个附件解析失败，模型将无法读取其内容。可点击附件的重新解析按钮重试，或先在「设置 → 文档解析」中配置云解析服务。",
    visionWarning:
      "当前模型「{model}」未标记支持图片输入，图片将以文字占位符发送。可在「设置 → Providers」中为它勾选「图片输入」。",
    placeholder: "输入消息，Enter 发送，Shift+Enter 换行",
    thinking: "Agent 正在思考…",
    parsingShort: "附件解析中…",
    send: "发送 (Enter)",
    stop: "停止生成",
    stopping: "正在停止…",
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
    /** Leaves the workspace for the workspace home — the only way back, now that the
     *  dropdown it replaced is gone. */
    allWorkspaces: "全部工作区",
    sessions: "会话",
    newSession: "新建会话",
    renameHint: "双击重命名",
    noSessions: "暂无会话",
    openNav: "打开导航",
    /** The header toggle's label, which names the *action* — so it changes with the state
     *  rather than describing the button, and there is no second "current state" string. */
    collapse: "收起侧边栏",
    expand: "展开侧边栏",
  },

  /**
   * The workspace file browser. Its own domain rather than a corner of `sidebar`, because
   * the tree is not a part of the sidebar conceptually — the sidebar is just where it lives.
   */
  files: {
    tab: "文件",
    refresh: "刷新文件列表",
    empty: "这个工作区还没有文件",
    /**
     * Shown under a directory that held more entries than one reply carries. Says how many
     * are shown rather than only that some are missing: "too many files" alone leaves the
     * reader guessing whether they are looking at 200 of 201 or 200 of 20,000.
     */
    truncated: "内容过多，仅显示前 {count} 项",
    /** The accessible name of the tree; the rows carry their own names. */
    treeLabel: "工作区文件",
    retry: "重试",
    preview: {
      loading: "正在读取…",
      /** Markdown's two views. Rendered first, because reading a document is the common case;
       *  source is what you switch to in order to see what was actually written. */
      rendered: "预览",
      source: "源码",
      /** The accessible name of the two-segment control those labels sit in. */
      viewLabel: "查看方式",
      /** The whole of what an unrenderable file gets: no bytes are fetched, so there is
       *  nothing to show but the name and the reason. */
      unsupported: "暂不支持预览这种格式",
      unsupportedHint: "目前可以预览纯文本与 Markdown 文件。",
      /** Appended to the metadata line when the file was longer than the preview cap. */
      truncated: "仅显示前 {size}",
      size: "大小",
    },
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
      groupPublic: "公开的 Copilot",
      groupMine: "我的 Copilot",
      byAuthor: "由 {name} 公开",
      advanced: "其他参数（新建时可一并设定，之后也能在会话参数里改）",
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

    /**
     * The workspace home: the card grid the app opens on.
     *
     * `sessions` and the `activity.*` buckets are the plural family — `en` carries `|`
     * branches and this catalog does not, and both are called `t(key, { count }, count)`.
     * A bucket past a week is a bare date and has no entry here on purpose: there is nothing
     * to say about it beyond the value itself.
     */
    home: {
      title: "选择工作区",
      subtitle: "Agent 只会在选中的工作区目录里读写文件。",
      newCard: "新建工作区",
      empty: "还没有工作区",
      emptyHint: "创建一个工作区后，Agent 会在其中读写文件。",
      /** The card is one big button; this is its accessible name. */
      open: "打开工作区「{name}」",
      sessions: "{count} 个会话",
      activity: {
        never: "暂无活动",
        now: "刚刚",
        minutes: "{count} 分钟前",
        hours: "{count} 小时前",
        days: "{count} 天前",
      },
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
      ask_user: "询问用户",
      ila_quiz: "小测",
      ila_review_quiz: "批改小测",
      ila_make_plan: "制定/编辑计划",
      ila_read_plan: "查看计划",
      ila_update_plan_progress: "更新计划进度",
    },
    done: "完成",
    running: "运行中",
    args: "参数",
    result: "结果",
  },

  /**
   * The `ask_user` card. Wording for a question the agent is putting to the user, and for
   * the record it leaves behind once answered — the two read differently on purpose, since
   * one is an invitation and the other is history.
   */
  askUser: {
    title: "询问用户",
    /** One per `AskUserStatus`, plus the moment before the turn has finished persisting. */
    preparing: "准备问题中",
    awaiting: "等待你的回答",
    answered: "已确认",
    skipped: "已跳过",
    dismissed: "已取消",
    /** The status line under a card whose questions were never answered. */
    skippedHint: "你直接发了新消息，这组问题已作废。",
    dismissedHint: "你取消了这组问题，助手会自行判断。",
    other: "其他（手动输入）",
    otherPlaceholder: "请输入…",
    multiSelectHint: "可多选。",
    /** A one-question card sends itself on a pick; this is what stops that being a surprise. */
    autoSubmitHint: "只有一道题，选择后会自动提交。",
    /** `{current}` and `{total}` are 1-based. */
    step: "第 {current} / {total} 题",
    previous: "上一题",
    next: "下一题",
    submit: "提交",
    cancel: "取消询问",
    unanswered: "未回答",
    /** The disclosure that reveals the options the agent originally offered. */
    details: "查看详情",
    /** Heads the options list in the detail view, the chosen ones ticked. */
    options: "选项",
  },
  quiz: {
    title: "小测",
    /** One per `ToolCallStatus`, plus the moment before the turn has finished persisting. */
    preparing: "准备题目中",
    awaiting: "等待你的作答",
    answered: "已提交",
    skipped: "已跳过",
    dismissed: "已取消",
    /** The status line under a card whose questions were never answered. */
    skippedHint: "你直接发了新消息，这次小测已作废。",
    dismissedHint: "你取消了这次小测，助手会自行判断。",
    multiSelectHint: "可多选。",
    /**
     * The third state, mutually exclusive with a choice. Named for what the user means
     * rather than for the control, because the box under it is where they say which.
     */
    unsure: "不确定",
    unsureHint: "选它会清空上面的选择：这是第三种作答，不是其中一个选项。",
    unsureReasonLabel: "不确定的原因",
    unsureReasonPlaceholder: "可以说说为什么：没学过、记不清，或者觉得题目本身有问题…",
    notesLabel: "我的想法",
    notesPlaceholder: "写下你的理解或疑问（可选）",
    /** `{current}` and `{total}` are 1-based. */
    step: "第 {current} / {total} 题",
    previous: "上一题",
    next: "下一题",
    submit: "提交",
    cancel: "取消小测",
    unanswered: "未回答",
    /** The disclosure that reveals the options the agent originally offered. */
    details: "查看详情",
    /** Heads the options list in the detail view, the chosen ones ticked. */
    options: "选项",

    /* ------------------------------ quiz widget panel ------------------------------ */
    empty: "还没有测验题",
    viewList: "列表",
    viewTree: "按章节",
    filterAll: "全部",
    filterAnswered: "已作答",
    filterSkipped: "已跳过",
    filterWrong: "错题",
    /** The two tree roots: questions under the plan, and session-level ones. */
    groupInPlan: "学习测验",
    groupOther: "其他问题",
    /** The panel's status for a question whose card is still answerable. */
    pending: "待作答",
    verdictCorrect: "正确",
    verdictIncorrect: "错误",
    verdictUnsure: "不确定",
    verdictUngraded: "未判分",
    /** Suffix on a chapter folder whose node a plan edit removed. */
    nodeMissing: "章节已删除",
    detail: {
      title: "题目详情",
      yourAnswer: "你的回答",
      feedback: "解析",
      waitingGrade: "等待助手判分…",
      /** Only skipped questions can be made up. */
      makeupHint: "这道题当时没有作答（跳过或取消了小测），可以在这里补答，提交后助手会判分。",
      makeupSubmit: "提交补答",
      followup: "追问",
      followupPlaceholder: "针对这道题继续追问…",
      followupSend: "发送追问",
      close: "关闭",
    },
    /**
     * The user message a make-up submission drives, after the answer is persisted.
     * Model input: quotes the GLOBAL id so grading lands on the same question and the
     * model must not issue a new quiz. Params: id, qid, question, options, answer.
     */
    makeupMessage:
      "【补答】这是我对一道之前未作答题目的补答（当时跳过或取消了小测），不是新题目，请不要重新调用 ila_quiz 出题。\n" +
      "题目 ID：{id}（编号 {qid}）\n" +
      "题目：{question}\n" +
      "可选选项：{options}\n" +
      "我的补答：{answer}\n" +
      "请针对我的补答判分：用完全一致的题目 ID 调用 ila_review_quiz，给出 verdict 和讲解。",
    /** The follow-up user message; quotes the same global id. Params: id, qid, question, text. */
    followupMessage:
      "关于题目 {id}（编号 {qid}）的追问。\n题目：{question}\n我的追问：{text}\n请直接解答，不需要重新出题。",
  },

  message: {
    copyReply: "复制回复",
    stopped: "已停止",
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

  /**
   * The generation parameters, named once.
   *
   * One namespace rather than a copy per surface, because three places now show this same set of
   * seven fields — the Copilot editor's defaults, a conversation's parameters, and the advanced
   * section of the new-session dialog — and three copies of "all session parameters" drift the
   * first time one of them gains a field. The *labels* were once the Copilot editor's and the
   * session dialog's separately, which is exactly the drift this replaces.
   */
  params: {
    provider: "服务商",
    model: "模型",
    inherit: "继承默认",
    temperature: "Temperature",
    temperatureHint: "取值范围 0 ~ 2，数值越大回答越随机。",
    topP: "Top P",
    topPHint: "取值范围 0 ~ 1，通常与 Temperature 二选一调节。",
    maxOutput: "最大输出",
    maxOutputHint: "单位 token，限制单次回复的最大长度。",
    maxHistory: "最多携带历史消息",
    maxHistoryAll: "全部（不截断）",
    maxHistoryHint: "单位「条」，超出时从最早的消息开始丢弃。",
    maxSteps: "最大工具轮数",
    maxStepsHint: "单位「轮」，单轮回复中最多执行多少次「模型 → 工具」循环。",
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
    tools: "可用工具",
    allTools: "全部工具可用",
    allToolsHint: "这个 Copilot 可以使用所有工具，之后新增的工具也会自动包含。",
    toolsHint: "只有勾选的工具可用；一个都不勾选就是不使用任何工具。",
    boundToolsHint: "部分工具随控件自动启用（例如「计划」控件的制定/查看/更新计划工具），不在此列表中，也无需勾选。",
    public: "公开这个 Copilot",
    publicHint: "公开后所有账号都能看到并使用它，但只有你能修改或删除。",
    defaults: "默认参数（新建会话时复制到会话中，之后可在会话里单独调整）",
    widgets: "安装控件",
    widgetsHint: "用这个 Copilot 新建会话时，会把勾选的控件安装到那个会话里，之后可以在会话参数中单独调整。",
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
      add: "新建 Provider",
      default: "默认",
      keySet: "Key 已配置",
      keyMissing: "未配置 Key",
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
      addParser: "添加服务",
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
      add: "新建 Copilot",
      inUse: "当前会话使用中",
      empty: "还没有 Copilot，点击「新建 Copilot」创建一个。",
      groupPublic: "公开的 Copilot",
      groupMine: "我的 Copilot",
      byAuthor: "由 {name} 公开",
      published: "已公开",
      viewPrompt: "查看它的设定",
      promptNone: "没有填写系统设定。",
      copyToMine: "复制到我的",
      introBefore:
        "Copilot 定义一段系统设定（System Prompt）、可用工具与默认生成参数。新建会话时选择一个 Copilot，系统设定与默认参数会被",
      introCopied: "整个复制",
      introAfter: "到该对话中 —— 之后修改 Copilot 不会影响已开始的对话，对话里也能单独改自己的设定。",
      summarySteps: "最多 {count} 轮工具",
      summaryHistory: "历史 {count} 条",
      summaryTools: "{count} 个工具",
      summaryAllTools: "全部工具",
      summaryNoTools: "不使用工具",
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
      detail: "已经使用它的会话不受影响，会保留创建时复制过去的系统设定与参数。",
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
    addModel: "添加模型",
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

  /**
   * Widgets — the right sidebar's extension panels.
   *
   * Two fixed parts and no label of its own: the panel's own strings live here, and each
   * widget's name and hint are reached through a *literal* key held in the client registry
   * (`widgets.<id>.name`), which is what keeps the i18n guard's dynamic-prefix allowlist from
   * needing a `widgets.` entry — see `apps/web/src/widgets/registry.ts`.
   */
  widgets: {
    /** The toggle button's label names the *action*, and `aria-pressed` carries the state. */
    install: "安装",
    uninstall: "卸载",
    heading: "控件",
    workspaceLead: "在这里安装的控件，会出现在这个工作区每个会话的右侧栏里。",
    sessionLead: "在这里安装的控件只影响这个会话。",
    panel: {
      /** Action-named, like `sidebar.collapse`/`expand` — the state is on the button already. */
      layoutTop: "标签栏放到顶部",
      layoutLeft: "标签栏放到左侧",
      collapse: "收起控件栏",
      expand: "展开控件栏",
      resize: "调整控件栏宽度（左右方向键微调）",
      more: "更多控件",
    },
    open: "打开控件栏",
    /**
     * The session parameters dialog with no conversation open. Distinct from
     * `widgets.sessionStats.noSession`, which is the panel saying it has nothing to show: this
     * one says a widget has nowhere to be installed *yet*.
     */
    noSession: "还没有会话，控件要装到某个会话里。",
    loadFailed: "读取数据失败",
    retry: "重试",
    messages: "消息",
    tokens: "Tokens",
    workspaceStats: {
      /**
       * "（Demo）" is part of the name, not a note about it: these two are shipped as
       * demonstrations of the framework rather than as features, and a tab that reads as a
       * finished product would invite someone to rely on it.
       */
      name: "工作区统计（Demo）",
      hint: "当前工作区的会话列表，以及每个会话的消息数与 token 消耗。",
      empty: "这个工作区还没有会话。",
    },
    workspaceSettings: {
      title: "工作区设置",
      liveHint: "改动会立刻反映在右侧栏上。",
    },
    sessionStats: {
      name: "会话统计（Demo）",
      hint: "当前会话的消息数与 token 消耗。",
      noSession: "打开一个会话后，这里会显示它的统计。",
      context: "本轮上下文",
    },
    plan: {
      name: "计划",
      hint: "由助手维护的学习计划：树状目录、进度跟踪与历史版本。",
      noSession: "打开一个会话后，这里会显示它的计划。",
    },
    quiz: {
      name: "测验",
      hint: "本会话的小测题目：按章节归类、错题筛选、补答与追问。",
      noSession: "打开一个会话后，这里会显示它的测验题目。",
    },
  },

  /**
   * The plan widget's own strings. Widget display name/hint live under `widgets.plan`; these
   * are the panel and its tree.
   */
  plan: {
    empty: "这个会话还没有计划。让助手制定一个学习计划后，它会出现在这里。",
    version: "计划版本",
    versionLatest: "最新 V{n}",
    versionN: "V{n}",
    historyBanner: "正在浏览历史版本 V{n}（只读，不影响最新计划）",
    historyLoadFailed: "这个历史版本读取失败，可能已不存在。",
    showLevel: "只展开到第 {n} 级",
    expandAll: "全部展开",
    expandCurrentPath: "只展开当前学习节点所在的路径",
    expand: "展开",
    collapse: "折叠",
    jumpToCompletion: "跳转到完成这个节点的位置",
    jumpToStart: "跳转到开始学习这个节点的位置",
    jumpToChapter: "跳到本章节",
    jumpConfirm: "是否跳到章节 {number} {title} 学习？",
    jumpConfirmDetail: "尚未完成的前置章节会标记为「已跳过」（包括当前进行中的章节），以后可以回来补学。",
    jumpConfirmOk: "跳到本章节",
    /** The user message assembled after a jump; {number} and {title} name the target. */
    jumpMessage: "调整进度，跳到章节{number} {title}",
    adjust: "调整计划",
    adjustPlaceholder: "边浏览计划边写下调整意见，例如：把第三章拆成两章、增加一节练习…",
    adjustSend: "发送调整意见",
    adjustCancel: "取消",
    /** The user message prefix assembled from the footer composer. */
    adjustMessage: "调整计划：{text}",
    status: {
      not_started: "未开始",
      in_progress: "进行中",
      completed: "已完成",
      skipped: "已跳过",
      deleted: "已删除",
    },
  },

  /** The `ila_make_plan` create-vs-new-conversation choice card. */
  planConflict: {
    title: "已存在一个计划",
    preparing: "等待你的选择",
    awaiting: "等待你的选择",
    answered: "已选择",
    dismissed: "已取消",
    question: "这个会话已经有一个计划了。要把新内容作为新版本覆盖到当前计划，还是为它新建一个会话？",
    edit: "覆盖当前计划（新版本）",
    newSession: "新建会话并放入该计划",
    cancel: "取消",
    choseEdit: "已将新计划作为新版本覆盖到当前会话。",
    choseNewSession: "已新建一个会话，并把该计划作为 V1 放入其中，页面已自动跳转。",
    dismissedHint: "你取消了选择，助手不会改动现有计划。",
  },

  sessionSettings: {
    title: "会话参数",
    scopeExisting: "这些参数只作用于当前会话。",
    scopeNew: "还没有会话，参数会应用于即将创建的新会话。",
    scopeSuffix: " 留空表示退回到全局默认值。",
    systemPrompt: "系统设定（System Prompt）",
    systemPromptPlaceholder: "这个对话要扮演什么角色…",
    systemPromptHint:
      "只属于这个对话。新建会话时从 Copilot 复制一份过来，之后各自独立 —— 在这里修改不会影响那个 Copilot。",
    reset: "重置",
  },

  errors: {
    NAME_REQUIRED: "名称不能为空。",
    WORKSPACE_NOT_FOUND: "工作区不存在，可能已被删除。",
    COPILOT_NOT_FOUND: "Copilot 不存在，可能已被删除。",
    SESSION_NOT_FOUND: "会话不存在，可能已被删除。",
    TITLE_EMPTY: "标题不能为空。",
    UNSUPPORTED_FILE_TYPE: "不支持该文件类型：{mimeType}",
    SOURCE_NOT_FOUND: "文件不存在，可能已被删除。",
    SOURCE_STORE_FAILED: "文件保存失败，请重试。",
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
    REASONING_NOT_DECLARED: "这个模型需要回传推理内容，但设置里没有为它开启「推理模型」，服务商因此拒绝了请求。请在设置中为这个模型勾选「推理模型」后重试。",
    MESSAGE_REQUIRED: "消息内容不能为空。",
    QUESTION_NOT_PENDING: "这组问题已经不需要回答了，可能已经提交或作废。",
    INVALID_ANSWER: "提交的回答不完整或已失效，请刷新页面后重试。",
    FILE_NOT_FOUND: "文件或目录不存在，可能已被删除或重命名。",
    INVALID_FILE_PATH: "这个位置不在工作区内，无法访问。",
    NOT_A_DIRECTORY: "该路径不是一个目录。",
    NOT_A_FILE: "该路径不是一个文件。",
    UNAUTHENTICATED: "登录已失效，请重新登录。",
    USERNAME_REQUIRED: "用户名不能为空。",
    USERNAME_TOO_LONG: "用户名不能超过 {max} 个字符。",
    UNKNOWN_WIDGET: "当前版本没有这个控件，请刷新页面后再试。",
    WIDGET_SCOPE_UNSUPPORTED: "这个控件不能在当前层级安装。",
    PLAN_VERSION_NOT_FOUND: "这个计划版本不存在。",
    PLAN_NODE_NOT_FOUND: "找不到这个计划节点，可能已被删除或已完成。",
    QUIZ_QUESTION_NOT_FOUND: "找不到这道测验题。",
    QUIZ_NOT_ANSWERABLE: "这道题当前不能补答（只有跳过或取消小测时未作答的题目可以补答）。",
  },

  /**
   * The account's uploaded files.
   *
   * `delete.detail` carries the part a user cannot guess: that deleting a conversation did
   * *not* delete this file, and which way round the two actions are. Without it, "delete"
   * reads as tidying up something already gone.
   */
  sources: {
    title: "已上传的文件",
    lead: "这些是你上传过的全部文件，属于你的账号，不属于某一次对话。同一个文件在多个对话里被引用时，只会保存和解析一次。",
    open: "已上传的文件",
    loading: "读取中…",
    empty: "还没有上传过文件。在输入框点回形针、或直接粘贴截图即可上传。",
    parsed: "已解析",
    parsedChars: "已解析 {count} 字",
    parsing: "解析中…",
    parseFailed: "解析失败",
    delete: {
      title: "删除文件",
      message: "确定要删除「{name}」吗？",
      detail: "文件本身、已解析的文本，以及在所有对话里的引用都会被删除，无法恢复。这些对话里已发出的消息仍会显示附件，但打不开了。",
      action: "删除文件",
    },
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
