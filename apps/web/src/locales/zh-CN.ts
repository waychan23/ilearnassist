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
    add: "添加",
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
    /** The same verb while the request is in flight — the button's pending label. */
    saving: "保存中…",
    close: "关闭",
    edit: "编辑",
    /*
     * Verbs and one noun that two domains now say: the sidebar acts on a conversation, the
     * workspace cards act on a workspace. Keying either copy `sidebar.*` would have put the
     * card's wording behind a key named after a component that no longer owns the idea.
     */
    rename: "重命名",
    signOut: "退出登录",
    back: "返回",
    loading: "加载中…",
    retry: "重试",
    copyFailed: "复制失败，请手动选中复制",
  },

  /**
   * How long ago something happened, from `composables/relativeTime.ts`.
   *
   * A namespace of its own rather than one per surface: the workspace cards and the file lists
   * both show a timestamp, and the sentence is the same sentence. A key under either surface
   * would be a copy of the other's wording.
   */
  time: {
    now: "刚刚",
    minutes: "{count} 分钟前",
    hours: "{count} 小时前",
    days: "{count} 天前",
  },

  /**
   * Diagrams: the card that draws one in the conversation, and the viewer that enlarges it.
   *
   * Not under `tools.` with the tool's own name (`tools.name.ila_diagram`), because these are
   * about the *drawing* rather than about the call: the same sentences are shown by the file
   * preview, which knows nothing about a tool call.
   */
  diagram: {
    /** While mermaid is parsing and laying out — measured in tens of milliseconds, not seconds,
     *  but a diagram that appears from nowhere is a jump. */
    rendering: "正在绘制图表…",
    /** Mermaid rejected the source. The model's own syntax error, so the sentence says what
     *  happened rather than blaming the app — and the source is shown with it. */
    failed: "这张图无法绘制，Mermaid 无法解析下面的源码。",
    /** Past the cap the source is shown and not drawn: layout is not linear in the input, and
     *  a diagram nobody can read is not worth a frozen tab. */
    tooLarge: "这张图超过 {size} 字符，已改为显示源码。",
    /** The viewer. `expand` is its trigger, on the card and in the file preview. */
    expand: "放大查看",
    viewTitle: "查看图表",
    /** The viewer's own heading when it is showing a table rather than a drawing. */
    tableTitle: "查看表格",
    zoomIn: "放大",
    zoomOut: "缩小",
    /**
     * Clicking the percentage returns to 100 %. Named for the state rather than for the gesture
     * because that is what the button shows — it is the readout that is clickable.
     */
    fit: "恢复到 100%",
    maximize: "放大窗口",
    restore: "缩小窗口",
    /** The viewer's download control, for a drawing. */
    download: "下载图片",
    /**
     * The three formats, named as a person would ask for them rather than as MIME types — and the
     * parenthetical is the one thing they differ by that a reader cannot see from the name: what
     * happens where the picture has no ink. JPG says "the current theme's background" rather than
     * "white" because that is what it does, and a dark-palette diagram on white is illegible.
     */
    formats: {
      png: "PNG 图片（透明背景）",
      jpg: "JPG 图片（带主题背景色）",
      svg: "SVG 矢量图",
    },
    /** A download that produced nothing. Loud on purpose: the dialog closes either way, so
     *  silence would look exactly like a file that was saved. */
    downloadFailed: "下载失败，这张图没能导出为文件。",
    /** What the table's copy control writes, said once because the button cannot say both. */
    copyHint: "复制为 HTML 表格，粘贴到纯文本编辑器时则为 Markdown",
    /** The label on the card's disclosure, which shows the source rather than the drawing. */
    source: "源码",
    /** The label before the model's description in the viewer and file preview. */
    summary: "说明",
  },

  app: {
    /**
     * The product name as the app *displays* it — on the login screen, in the workspace home's
     * rail, when there is no session and no workspace to name the topbar after, and in the tab
     * (`composables/locale.ts` keeps the two in step).
     *
     * The rest of the repo keeps the other name: `@ilearnassist/*`, `app.setName`, the userData
     * directory, `ilearnassist.sqlite`, and the `[ilearnassist] listening on` line the desktop
     * panel parses. That split is deliberate — every one of those is an *identifier*, and two of
     * them decide where a user's data already lives. Renaming the display name is this value in
     * two catalogs; renaming the product is a migration.
     */
    title: "交互式学习助理",
    configBanner: {
      before: "尚未配置可用的 API Key。点击右上角",
      action: "设置 → Providers",
      after: "添加一个 Provider 并填入 Key，保存后即刻生效。",
    },
  },

  /**
   * The sign-in form.
   *
   * `note` says what the session actually is rather than only what it does: how long it lasts
   * without being touched, and where to go when the password is gone. The second half matters
   * because there is deliberately no self-service reset — an account that has forgotten its
   * password has exactly one route, and it runs through an administrator.
   */
  login: {
    lead: "使用用户名和密码登录。",
    username: "用户名",
    usernamePlaceholder: "例如：你的名字",
    password: "密码",
    passwordPlaceholder: "请输入密码",
    submit: "登录",
    note: "登录状态会保持 7 天，无需反复登录。忘记密码时，请联系管理员重置。",
  },

  password: {
    title: "修改密码",
    lead: "{name}，请先设置一个新密码再继续。",
    current: "当前密码",
    new: "新密码",
    confirm: "确认新密码",
    hint: "至少 {min} 个字符。",
    submit: "保存新密码",
    mismatch: "两次输入的密码不一致。",
    tooShort: "新密码至少需要 {min} 个字符。",
    unchanged: "新密码不能和当前密码相同。",
    signOut: "退出登录",
  },

  /** The account's own page: who it is, and its own password. */
  account: {
    title: "个人信息",
    identity: "账号",
    passwordLead: "修改密码后，这个账号在其他设备上的登录会全部失效。",
    passwordChanged: "密码已修改。",
    /**
     * The introduction, which is prompt input rather than a profile page's decoration.
     *
     * The lead sentence is the one place a user is told where this text goes. It is not a detail
     * to leave implicit: the account is writing something that reaches a model on every turn, and
     * finding that out afterwards is how a field meant to help becomes a surprise.
     */
    about: {
      title: "个人介绍",
      lead: "可选。写下你的背景、领域、擅长和兴趣，助手会在每一次对话中参考它，从而把讲解的深浅调到合适的位置。",
      label: "关于我",
      placeholder: "例如：我是做后端开发的，熟悉 Java 和分布式系统；正在自学机器学习，线性代数是薄弱环节，喜欢从具体例子入手。",
      /** `{used}` and `{max}` are character counts. */
      count: "{used} / {max} 字",
      save: "保存介绍",
      saved: "介绍已保存。",
      /** The save button's tooltip while there is nothing to save. */
      noChanges: "还没有修改",
    },
  },

  /**
   * What an account may do. Keyed by the role id the server stores, so the two sides name the
   * same thing — the label is the only translated part.
   */
  roles: {
    superadmin: "超级管理员",
    admin: "管理员",
    user: "普通用户",
  },

  /** The platform console: the installation's own management screens. */
  admin: {
    title: "平台管理",
    /** The toggle that opens the section menu, on a viewport where it is a drawer. */
    openMenu: "打开菜单",
    /**
     * The line under each section's title. Keyed by section rather than one sentence for the
     * console, because the three sections answer three different questions and a shared line
     * would have to be vague enough to fit all of them.
     */
    subtitle: {
      users: "管理这个实例上的账号。",
      providers: "配置所有账号共用的模型服务；普通用户只能在已配置的模型中选择使用。",
      documents: "配置所有账号共用的文档解析方式。",
      uploads: "所有账号共用的上传限制。",
    },
    /** The left menu. One entry per section; the key is the section id. */
    nav: {
      users: "用户管理",
      providers: "模型服务",
      documents: "文档解析",
      uploads: "上传设置",
    },
    /**
     * The upload limit. The unit is MB here and bytes on the wire, and the conversion lives in
     * `UploadsSection` — the one boundary where a person types a number.
     */
    uploads: {
      maxSize: "单个文件大小上限（MB）",
      range: "可设置 {min}–{max} MB。",
      saving: "保存中…",
      saved: "已保存",
      /**
       * The half of the rule a number cannot state: what happens to a file past the limit. Said
       * here rather than discovered, because "why can't I upload this" is the question the setting
       * exists to answer, and the refusal arrives before the file is sent.
       */
      note: "超过上限的文件会在上传前被拒绝，并提示实际上限。附件与工作区文件共用这一个限制。",
    },
    create: "新建用户",
    roles: "角色",
    you: "你",
    disabled: "已禁用",
    mustChange: "待改密码",
    enable: "启用",
    count: "共 {count} 个账号",
    createPasswordHint:
      "初始密码由系统随机生成，创建后只显示一次，请复制并发送给用户。对方首次登录必须修改密码。",
    selfLocked: "不能禁用或降级自己的账号。",
    /* Three refusals the account doing the looking can see. Each names the rule rather than
       the click, because in all three cases the control is refused for a reason the person
       cannot work out from the button. */
    rowLocked: "只有超级管理员才能管理管理员账号。",
    resetPanel: "超级管理员不能在网页端重置自己的密码，请在桌面端控制面板中重置。",
    grantHint: "只有超级管理员才能授予管理员角色。",
    superadminFixed:
      "超级管理员只能由桌面控制面板在初始化时创建，不能在这里新建或指定；整个系统只有一个。",
    disable: {
      action: "禁用",
      title: "禁用账号",
      message: "确定要禁用「{name}」吗？",
      detail: "该账号会立即退出登录，并且无法再次登录。它的工作区、文件和对话都会保留，随时可以重新启用。",
      confirm: "禁用",
    },
    reset: {
      action: "重置密码",
      title: "重置密码",
      message: "确定要重置「{name}」的密码吗？",
      /* The two cases differ in the one way nobody would predict: resetting your own password
         does not force a change, resetting somebody else's does. */
      detailSelf: "系统会生成一个新密码。你当前的登录会失效，随后自动换成新密码继续。",
      detailOther: "系统会生成一个新密码，并让该账号立即退出登录。对方首次登录时必须修改密码。",
      confirm: "重置",
    },
    kick: {
      action: "踢下线",
      title: "强制下线",
      message: "确定要让「{name}」退出登录吗？",
      detail: "该账号在所有设备上的登录都会立即失效。密码不变，之后可以重新登录。",
      confirm: "强制下线",
      self: "要退出自己的登录，请用「退出登录」。",
    },
    credential: {
      created: "账号已创建。请把下面的信息发送给用户：",
      reset: "密码已重置。请把下面的新密码发送给用户：",
      username: "用户名",
      password: "密码",
      note: "这个密码只会显示这一次，系统只保存哈希值，之后任何人都无法再查看它。对方首次登录时必须修改密码。",
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
    /**
     * The whole of the rename affordance on the topbar, and it is a tooltip rather than a
     * button: the title itself is the control, so this is where the gesture is taught.
     */
    editTitleHint: "点击编辑标题",
    autoBadgeTitle: "标题由 AI 根据第一轮对话自动生成",
    start: "开始对话",
    startHint: "在下方输入消息，Agent 将按需调用工具。",
    startAction: "新建会话（选择助理）",
    jumpToLatest: "回到最新",
  },

  composer: {
    parsing: "正在解析附件，完成后即可发送…",
    parseFailed:
      "有 {count} 个附件解析失败，模型将无法读取其内容。可点击附件的重新解析按钮重试，或先在「设置 → 文档解析」中配置云解析服务。",
    visionWarning:
      "当前模型「{model}」未标记支持图片输入，图片将以文字占位符发送。可在「设置 → Providers」中为它勾选「图片输入」。",
    /*
     * The `@` is written as `{'@'}` because vue-i18n reads a bare one as a *linked message*
     * (`@:key`), and a message it cannot compile throws at render time — which takes down the
     * whole component the message is in. Same rule as a literal `|` in a plural.
     */
    placeholder: "输入消息，Enter 发送，Shift+Enter 换行；输入 {'@'} 可引用资料",
    /** The `@` picker: nothing matched what has been typed, and nothing exists to match. */
    noSourceMatch: "没有匹配的资料。",
    noSources: "还没有可引用的资料。",
    /*
     * The picker's tabs, which double as its group headings — a filter that names the group it
     * keeps is one control rather than two that have to agree.
     */
    tabAll: "全部",
    tabWorkspace: "工作区",
    tabSource: "资料",
    /* The type filter's five pills. Coarser than the eight categories a source really has:
     * 文本 is text and markdown, 代码 is code and a diagram. */
    pillImage: "图片",
    pillText: "文本",
    pillCode: "代码",
    pillPage: "网页链接",
    pillOther: "其他文件",
    /*
     * The row that opens every workspace at once, `{'@'}`-escaped for the reason above. What it
     * makes readable is deliberately in the sentence: a grant that says only "all" is one nobody
     * can tell the size of.
     */
    allWorkspaces: "{'@'}所有工作区",
    /** Said when more rows matched than the list shows. */
    moreHidden: "还有 {count} 项未显示",
    noWorkspaceMatch: "没有匹配的工作区。",
    /** Removing one workspace from what this conversation may read. */
    scopeRemove: "不再引用「{name}」",
    thinking: "Agent 正在思考…",
    parsingShort: "附件解析中…",
    send: "发送 (Enter)",
    stop: "停止生成",
    stopping: "正在停止…",
    attach: "添加图片或文件",
    /*
     * The canned replies above the input. Each label is also the message that gets sent — the
     * chip *is* the sentence — which is why they are short enough to read as one and why the
     * component sends the rendered label rather than a separate string that could drift from it.
     *
     * `label` names the row rather than being sent: it says what the three chips are, for
     * someone who has not seen them answer anything yet.
     */
    quick: {
      label: "快捷回复",
      continue: "继续",
      yes: "是的",
      ok: "可以",
    },
    /* The session-parameters button's label lives under `sessionSettings.open`: three places
       open that dialog, and it is the dialog that owns the words. */
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
    /** The heading over the pinned group. Only ever drawn when that group has rows in it. */
    pinnedGroup: "置顶的",
    /** The two halves of one toggle, named as actions: a pin already set has only the
     *  opposite one to offer, and the button's title says which it will do. */
    pin: "置顶",
    unpin: "取消置顶",
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
    tab: "工作区文件",
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
    /*
     * The file manager. Four verbs, because a web app has no Finder behind it: without these
     * the workdir is a directory the agent writes into and the user can only look at.
     */
    newFolder: "新建文件夹",
    newFolderHint: "相对于当前目录的文件夹名称。",
    upload: "上传文件",
    rename: "重命名或移动",
    renameHint: "相对于工作区根目录的路径。输入新路径即可移动。",
    deleteTitle: "删除这个文件？",
    deleteDirectoryTitle: "删除这个文件夹？",
    deleteMessage: "「{name}」将从工作区中移除。文件会保留在回收目录中，但这里不再显示。",
    deleteDirectoryMessage: "「{name}」将从工作区中移除。只有空文件夹可以这样删除。",
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
      unsupportedHint: "可预览文本、Markdown、图表、图片、PDF 与 Office 文档。",
      /** A file the viewer claimed but could not draw. The library's own error is shown below
       *  it untranslated, the same treatment a provider's raw failure gets. */
      viewerFailed: "无法预览该文件",
      /** Appended to the metadata line when the file was longer than the preview cap. */
      truncated: "仅显示前 {size}",
      size: "大小",
      /** Filling the viewport, and going back — one control in two states, so the label says
       *  what pressing it will do rather than what the dialog currently is. */
      maximize: "最大化",
      restore: "还原窗口",
    },
    /**
     * A conversation's own directory — where the diagrams it draws are written.
     *
     * Its own dialog rather than a second tree in the sidebar, because these files belong to
     * one conversation rather than to the workspace, and because the sidebar's tree is the
     * same directory the file tools write into. The lead says where they are, since "why is
     * this not in the file tree" is the first question the list raises.
     */
  },

  session: {
    /**
     * What a conversation is called before it has a name of its own.
     *
     * Two roles, one string: the store **writes** this as the title at creation — in the
     * language being read, which is why it is a catalog key rather than the server's constant —
     * and it is still the fallback a list renders for a title that is somehow empty. It is a
     * placeholder either way: `titleSource` stays `auto`, so the auto-titler replaces it after
     * the first turn.
     */
    fallbackTitle: "（未命名）会话",
    new: {
      title: "新建会话",
      titleLabel: "标题（可选）",
      titlePlaceholder: "留空则为「{fallback}」",
      noCopilot: "不使用助理",
      noCopilotDesc: "使用内置的通用助手设定与默认参数。",
      noCopilots: "还没有助理。可在侧边栏的「助理」里创建。",
      groupPublic: "公开的助理",
      groupMine: "我的助理",
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
    /**
     * The workspace a new account starts with, created by `loadApp` on its first sign-in.
     *
     * A *name*, not a translation: it is written into the database once and stays whatever it was
     * when it was created, like every other workspace name. Seeding it in the language the account
     * is reading is the best that can be done, and is why it is a catalog key rather than a
     * constant in the store.
     */
    defaultName: "默认工作区",
    new: {
      title: "新建工作区",
      namePlaceholder: "例如：My Project",
      hint: "将在工作区根目录自动创建对应的子目录。",
      /*
       * The same three sentences as the settings dialog's description field, and repeated
       * rather than shared: `session.descriptionHint` is already the same sentence a second
       * time, and each surface's copy is free to move on its own — which is exactly what
       * a shared key would stop.
       */
      descriptionLabel: "描述（可选）",
      descriptionPlaceholder: "这个工作区用来做什么？",
      descriptionHint: "仅供你自己参考，不会发送给模型。",
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
        // Only this one is the card's own. The buckets are `time.*` below, shared with the
        // file lists.
        never: "暂无活动",
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
      ila_collect_page: "收藏网页",
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
      ila_diagram: "图表",
      /* 表 rather than 图表: the panel is 图表 (both halves), and this is the half that records a
         table — the word the card's own hint and the panel's filter both use. */
      ila_table: "表格",
      ila_query: "查询学习记录",
      ila_explore: "浏览其他工作区",
    },
    done: "完成",
    running: "运行中",
    args: "参数",
    result: "结果",
    /**
     * A run of consecutive tool calls, folded into one card. `count` is how many calls the
     * run holds; `name` is a `tools.name.*` label for the call still in flight.
     */
    group: {
      count: "{count} 个工具调用",
      running: "正在使用工具[{name}]…",
    },
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
    unsureReasonLabel: "不确定的原因",
    unsureReasonPlaceholder: "可以说说为什么：没学过、记不清，或者觉得题目本身有问题…",
    notesLabel: "我的想法",
    notesPlaceholder: "写下你的理解或疑问（可选）",
    /** `{current}` and `{total}` are 1-based. */
    step: "第 {current} / {total} 题",
    previous: "上一题",
    next: "下一题",
    /** The pager's third move: the next question with no answer at all. Absent when there is none. */
    nextUnanswered: "下一未答题",
    submit: "提交",
    cancel: "取消小测",
    unanswered: "未回答",
    /** The disclosure that reveals the options the agent originally offered. */
    details: "查看详情",
    /** Heads the options list in the detail view, the chosen ones ticked. */
    options: "选项",

    /* ------------------------------ quiz widget panel ------------------------------ */
    empty: "还没有测验题",
    /** The other nothing: questions exist, but the status filter is hiding all of them. */
    noMatch: "没有符合筛选条件的题目",
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
  },

  /**
   * The things a message can point at — the 追问 gesture's references.
   *
   * A namespace of its own rather than keys under `composer.` or `message.`, because the same
   * four words are needed in three places that have nothing to do with each other: the chip in the
   * composer, the block in the bubble the message was sent as, and the button that stages one.
   */
  turnRef: {
    /** In `TURN_REFERENCE_KINDS` order, so a missing one is a gap where it should be. */
    kind: {
      message: "选中的内容",
      diagram: "图",
      table: "表",
      note: "笔记",
      quiz: "题目",
    },
    /** The composer's chip row, and the control that takes one back off. */
    remove: "取消引用",
    /** The button that turns a selection into a staged reference. */
    ask: "追问",
  },

  message: {
    copyReply: "复制回复",
    stopped: "已停止",
    contextTokens: "本轮上下文 {count} tokens",
    delete: {
      title: "删除这条消息",
      message: "确定删除这条消息吗？",
      detail: "消息将从对话中移除，之后的对话不会再看到它。删除后，上一条消息会成为新的末尾。",
      action: "删除",
    },
    regenerate: {
      title: "重新生成回复",
      message: "确定让模型重新回答这条消息吗？",
      detail: "当前回复会被删除，模型将针对同一条消息重新作答。",
      action: "重新生成",
    },
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
    edit: "编辑助理",
    create: "新建助理",
    namePlaceholder: "例如：代码助手",
    description: "描述",
    descriptionPlaceholder: "一句话说明它的用途",
    systemPrompt: "System Prompt（设定）",
    systemPromptPlaceholder: "定义这个助理的角色、能力与行为约束…",
    systemPromptHint: "留空则使用内置的通用助手设定。",
    tools: "可用工具",
    allTools: "全部工具可用",
    allToolsHint: "这个助理可以使用所有工具，之后新增的工具也会自动包含。",
    toolsHint: "只有勾选的工具可用；一个都不勾选就是不使用任何工具。",
    boundToolsHint: "少数工具随控件自动启用（目前只有「测验」控件的出题与批改工具），不在此列表中，也无需勾选。计划、图表这类工具在这里可以正常勾选。",
    public: "公开这个助理",
    publicHint: "公开后所有账号都能看到并使用它，但只有你能修改或删除。",
    defaults: "默认参数（新建会话时复制到会话中，之后可在会话里单独调整）",
    widgets: "安装控件",
    widgetsHint: "用这个助理新建会话时，会把勾选的控件安装到那个会话里，之后可以在会话参数中单独调整。",
    /* The list. It used to live under `settings.`, because the list and the editor were two
       halves of one settings dialog; the list has a dialog of its own now, and the editor that
       shares this namespace is what makes `copilot.*` its domain rather than the app's. */
    countConfigured: "已配置 {count} 个助理",
    add: "新建助理",
    inUse: "当前会话使用中",
    empty: "还没有助理，点击「新建助理」创建一个。",
    groupPublic: "公开的助理",
    groupMine: "我的助理",
    byAuthor: "由 {name} 公开",
    published: "已公开",
    viewPrompt: "查看它的设定",
    promptNone: "没有填写系统设定。",
    copyToMine: "复制到我的",
    introBefore:
      "助理定义一段系统设定（System Prompt）、可用工具与默认生成参数。新建会话时选择一个助理，系统设定与默认参数会被",
    introCopied: "整个复制",
    introAfter: "到该对话中 —— 之后修改助理不会影响已开始的对话，对话里也能单独改自己的设定。",
    summarySteps: "最多 {count} 轮工具",
    summaryHistory: "历史 {count} 条",
    summaryTools: "{count} 个工具",
    summaryAllTools: "全部工具",
    summaryNoTools: "不使用工具",
    delete: {
      title: "删除助理",
      message: "确定删除助理「{name}」吗？",
      detail: "已经使用它的会话不受影响，会保留创建时复制过去的系统设定与参数。",
    },
  },

  /**
   * The Copilot list, as a noun: the dialog's own title and the two entry points that open it.
   *
   * Separate from `copilot.*` because that namespace is the *editor* — "新建 Copilot", "描述",
   * "可用工具" — and a label for the thing the editor edits is not one of its fields. `en` is
   * the same word, which is a product name rather than an untranslated string.
   */
  copilots: {
    title: "助理",
  },


  /*
   * The installation's own settings, and the one word that used to point at them.
   *
   * The dialog that held these screens is gone — providers and models, parsers and the app
   * defaults are the platform console's, because they are shared by every account and only an
   * administrator may write them. What was left here was `installationMoved`, a sentence the
   * Copilot list drew for an administrator who came looking for the provider list; it is gone
   * too, because a list of templates is not where a pointer to the console belongs when the
   * sidebar's own menu already has one.
   */
  settings: {
    /**
     * Where an unqualified file write lands. The three levels that ask this question — a
     * workspace, a Copilot, a conversation — share these words, and the caller supplies what
     * "inherit" means at its own level.
     */
    writeLocation: {
      label: "文件写入位置",
      workspace: "写入工作区（所有会话共享）",
      session: "写入会话（仅本会话可见）",
      hint: "这是默认位置：你在对话里明确说明时，以你的说明为准。",
      inheritWorkspace: "跟随工作区设置",
      inheritBuiltIn: "默认（写入会话）",
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
    defaults: {
      appSection: "默认模型",
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
    /* Two empty states, because the two readers have different next moves: an ordinary account
       cannot add a provider and the administrator reading it can. One message naming the
       console would send the first to a screen they cannot open. */
    empty: "还没有可用的模型。请联系管理员配置。",
    emptyAdmin: "还没有可用的模型。请在「平台管理 → 模型服务」中添加 Provider 与模型。",
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
      /*
       * The workspace's own name and description, above the settings it hands down. Both are
       * display-only — the description reaches no prompt, and changing the name moves no
       * directory (the slug is fixed at creation).
       */
      name: "工作区名称",
      namePlaceholder: "例如：线性代数",
      description: "工作区描述",
      descriptionPlaceholder: "这个工作区用来做什么？",
      descriptionHint: "仅供你自己参考，不会发送给模型。",
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
    thread: {
      name: "脉络",
      hint: "随会话自动整理的主题脉络：按计划章节与背景补充归类，点击可定位到对应消息。",
      noSession: "打开一个会话后，这里会随对话自动整理它的脉络。",
    },
    notes: {
      name: "笔记",
      hint: "在消息里选中内容即可标注或写下笔记：按内容关联，可随时定位回原文。",
      noSession: "打开一个会话后，这里会显示它的笔记。",
    },
    diagram: {
      name: "图表",
      hint: "这个会话画过的图表：点一条即可查看，也可以回到它被画出来的那条消息。",
      noSession: "打开一个会话后，这里会显示它画过的图表。",
      /** The panel's own link to the whole folder, which holds more than diagrams. */
      /** A row the conversation has a tool call for — the button that scrolls back to it. */
      locate: "定位到生成它的消息",
      /** Writing a note about a figure. Offered only where the notes panel has a home. */
      note: "为它记一条笔记",
      empty: "这个会话还没有画过图表，也没有记录过表格。",
      /** The panel's kind filter. Its empty value is the select's own "everything". */
      filterKind: "按类型筛选",
      allKinds: "全部",
      kinds: {
        diagram: "图",
        table: "表",
      },
      noMatch: "没有符合筛选条件的图表。",
      failed: "读取图表失败。",
      /** The thread the classifier put this diagram in. */
      inThread: "属于：{title}",
      /** The row exists but its file is gone. */
      missing: "文件已不存在",
    },
    insight: {
      name: "思考",
      hint: "回顾这个会话的计划、测验、脉络、笔记与图表，总结出你的难点、疑问、可延伸的方向等条目。",
      noSession: "打开一个会话后，这里可以回顾它的学习记录。",
      /** The button that runs a pass. A button, because a pass costs a whole model call. */
      generate: "生成思考",
      generating: "生成中…",
      generatingHint: "正在阅读这个会话的记录，可能需要一分钟。",
      /** The pass ran and produced nothing usable. The list above it is unchanged. */
      generateFailed: "这次总结没有得到可用的结果，上面的条目没有改动。",
      /**
       * The other reason a press produced nothing, and the opposite instruction to the one
       * above: nothing is broken, there is simply nothing to read yet.
       */
      nothingToReflect: "这个会话还没有可回顾的记录（计划、测验、脉络、笔记、图表）。先学习一会儿再回来。",
      empty: "还没有思考记录，点「生成思考」开始。",
      /** The toggle: `adopted` is what survives the next pass, so the label says what it does. */
      adopt: "采纳",
      release: "取消采纳",
      adoptedBadge: "已采纳",
      /** Said once, under the list, because the rule is not guessable from the controls. */
      keepNote: "只有「已采纳」的条目会在下次生成时保留，其余会被新的结果替换。",
      /**
       * The eight kinds. A dynamic key (`widgets.insight.types.<id>`) over the closed
       * `INSIGHT_TYPES` union — the one narrow prefix this feature adds to `DYNAMIC_PREFIXES`,
       * because eight literal keys would be eight chances to write one of them into the wrong
       * branch of a switch that has no other job.
       */
      types: {
        difficulty: "难点",
        confusion: "不理解",
        doubt: "存疑",
        strength: "已掌握",
        background: "背景知识",
        reading: "拓展阅读",
        advice: "学习建议",
        habit: "学习习惯",
      },
    },
    sources: {
      name: "参考资料",
      hint: "这个会话引用和产出的资料 —— 上传的文件、收藏的网页、写入的文件，可按内容类型筛选。",
      noSession: "打开一个会话后，这里会列出它的参考资料。",
      empty: "这个会话还没有参考资料。上传文件、引用资料或让助理写一个文件，都会出现在这里。",
      /** A filter rather than an empty conversation: the rows exist, the selection hides them. */
      noMatch: "没有符合筛选条件的资料。",
      missing: "已丢失",
      failed: "读取参考资料失败。",
    },
  },

  /** Client-side widget groups: a master row in the install list, no row of their own. */
  widgetGroups: {
    study: {
      name: "学习套装",
      hint: "一次安装/卸载 计划、测验、脉络 三个控件。",
    },
  },

  /**
   * The notes widget's own strings. Widget display name/hint live under `widgets.notes`;
   * these are the panel, the floating bar over a selection, and the window.
   *
   * `types.*` is reached through a `switch` with the key written out per case, never
   * `` t(`notes.types.${type}`) `` — a built key is invisible to the catalog guard, and
   * satisfying it would mean a bare `notes.` in `DYNAMIC_PREFIXES`, a prefix that hides a
   * typo in every string here.
   */
  notes: {
    types: {
      annotation: "标注",
      idea: "灵感",
      question: "疑问",
      opinion: "观点",
      other: "其他",
    },
    /** `count` is a plural: `en` carries both branches, `zh-CN` the one. */
    count: "{count} 条笔记",
    add: "新建笔记",
    empty: "还没有笔记。在消息里选中一段内容，就可以标注或写笔记。",
    /** A note with neither a body nor an annotation — the row still has to say something. */
    untitled: "（无内容）",
    open: "打开这条笔记",
    /** The row's chip for a note written about a 图 or a 表 instead of a passage. */
    target: {
      label: "打开它写的那{kind}",
      kinds: {
        diagram: "图",
        table: "表",
      },
      missing: "它写的{kind}已不存在",
    },
    /** The conversation is marked up by a different widget. Deliberately nameless. */
    claimedByOther: "另一个控件正在使用本会话的标注能力，暂时无法在此标注。",
    /**
     * The bar that floats over a selection. Its **label is the bar's**, not a widget's: the bar
     * belongs to the conversation and carries whatever the claiming widget offers, so naming it
     * after one of them would be wrong the moment a second contributed. The two action labels
     * below stay the notes widget's, because that is what those two buttons do.
     */
    toolbar: {
      label: "选中内容的操作",
      annotate: "标注",
      note: "笔记",
    },
    editor: {
      title: "笔记",
      newTitle: "新建笔记",
      editTitle: "编辑笔记",
      quoteLabel: "标注原文",
      /** The counterpart of 标注原文, for a note about a 图 or a 表. */
      targetLabel: "标注对象",
      contentLabel: "笔记内容",
      contentPlaceholder: "写下你的想法…",
      typeLabel: "笔记类型",
      /** Growing the window to write in, and putting it back where it was. One control in two
       *  states, so the label names what pressing it will do. */
      maximize: "放大窗口",
      restore: "缩小窗口",
      save: "保存",
      saving: "保存中…",
      locate: "定位",
      discardTitle: "放弃未保存的修改？",
      discardMessage: "关闭后，这次编辑的内容不会保留。",
      discardAction: "放弃",
    },
    remove: {
      title: "删除这条笔记？",
      message: "笔记删除后不会出现在列表里。",
      detail: "消息本身和它的标注原文都会保留。",
      action: "删除",
    },
  },

  /**
   * Exporting a conversation's notes into the source library — the topbar control, and the state
   * of the run it starts.
   *
   * Its own namespace rather than a corner of `notes.*`: this is about the *library*, and the
   * notes panel knows nothing about it. The three settled outcomes keep their own sentences,
   * because "there were no notes", "it worked" and "it produced nothing usable" ask the reader
   * for different things and a single failure line would conflate them.
   */
  noteSync: {
    action: "同步到资料库",
    /** The button's tooltip: what it does, and the one consequence worth knowing before pressing. */
    hint: "把这次会话的笔记导出成资料：会写进资料库，账号内其他会话也能引用。",
    running: "正在同步…",
    /** `count` is a plural: `en` carries both branches, `zh-CN` the one. */
    done: "已同步 {count} 条笔记",
    empty: "这次会话还没有笔记",
    failed: "同步失败",
    /** A `running` run past its timeout — the process that owned it is gone. */
    stuck: "上一次同步没有结束",
    force: "强制重新同步",
  },

  /**
   * The thread widget's own strings. Widget display name/hint live under `widgets.thread`;
   * these are the panel and its tree.
   */
  thread: {
    planBranch: "计划",
    otherBranch: "其他（背景补充）",
    empty: "对话进行中会在这里自动整理出主题脉络。",
    syncing: "正在整理脉络…",
    unassigned: "还有 {count} 条消息待整理",
    /** A tool-only assistant message has no text to preview. */
    toolCall: "（工具调用）",
    locate: "定位到这条脉络开始的消息",
    expand: "展开",
    collapse: "折叠",
    nodeMissing: "已从计划中删除",
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
    /** The button that opens this dialog — a title/aria-label, drawn as an icon alone. */
    open: "会话参数（温度、上下文长度、工具轮数…）",
    scopeExisting: "这些参数只作用于当前会话。",
    scopeNew: "还没有会话，参数会应用于即将创建的新会话。",
    scopeSuffix: " 留空表示退回到全局默认值。",
    /*
     * The conversation's name and its description. Both are stored, and both are display-only
     * in the sense that matters — neither reaches the model. The name is the one that has a
     * consequence: giving one stops the auto-titler from renaming the conversation later.
     */
    name: "会话名称",
    namePlaceholder: "例如：第三章复习",
    description: "会话描述",
    descriptionPlaceholder: "这个会话是关于什么的？",
    descriptionHint: "仅供你自己参考，不会发送给模型。",
    systemPrompt: "系统设定（System Prompt）",
    systemPromptPlaceholder: "这个对话要扮演什么角色…",
    systemPromptHint:
      "只属于这个对话。新建会话时从助理复制一份过来，之后各自独立 —— 在这里修改不会影响那个助理。",
    reset: "重置",
  },

  /**
   * The session write lock: which client may write to a conversation.
   *
   * A domain of its own rather than keys under `session` or `sidebar`, because the same two facts
   * are drawn in three places — the dot on a session row, the banner over the conversation, and
   * the composer's disabled send button — and none of those is where the concept lives.
   * `docs/session-locks.md` is the concept.
   */
  lock: {
    /** The dot's own words, and the row's `title`: this client holds it, so typing works here. */
    mine: "这个会话由当前客户端编辑，可正常发送",
    /** The other client's dot — orange, and the reason the conversation is read-only here. */
    other: "另一个客户端正在编辑这个会话，此处只读",
  },

  errors: {
    NAME_REQUIRED: "名称不能为空。",
    WORKSPACE_NOT_FOUND: "工作区不存在，可能已被删除。",
    COPILOT_NOT_FOUND: "助理不存在，可能已被删除。",
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
    FILE_EXISTS: "这个名字已经被占用了，请换一个名字。",
    PAGE_FETCH_FAILED: "无法保存这个网页链接：{detail}",
    UNAUTHENTICATED: "登录已失效，请重新登录。",
    USERNAME_REQUIRED: "用户名不能为空。",
    USERNAME_TOO_LONG: "用户名不能超过 {max} 个字符。",
    UNKNOWN_WIDGET: "当前版本没有这个控件，请刷新页面后再试。",
    WIDGET_SCOPE_UNSUPPORTED: "这个控件不能在当前层级安装。",
    PLAN_VERSION_NOT_FOUND: "这个计划版本不存在。",
    PLAN_NODE_NOT_FOUND: "找不到这个计划节点，可能已被删除或已完成。",
    QUIZ_QUESTION_NOT_FOUND: "找不到这道测验题。",
    QUIZ_NOT_ANSWERABLE: "这道题当前不能补答（只有跳过或取消小测时未作答的题目可以补答）。",
    NOTE_NOT_FOUND: "找不到这条笔记，可能已经被删除了。",
    NOTE_TYPE_INVALID: "这个笔记类型不存在。",
    FIGURE_NOT_FOUND: "找不到这个图表，它可能已经被修改或删除了。",
    REFERENCE_NOT_FOUND: "引用对象已经不存在了（可能已被删除或修改），请重新发送。",
    SYNC_IN_PROGRESS: "这个会话正在同步到资料库，请稍候。",
    INSIGHT_NOT_FOUND: "找不到这条洞察，可能已经被新一次总结替换了。",
    MESSAGE_NOT_FOUND: "找不到这条消息，可能已经被删除了。",
    MESSAGE_NOT_LAST: "只能删除最后一条消息，请刷新页面后再试。",
    NO_REPLY_TO_REGENERATE: "没有可以重新生成的回复（最后一条不是助手回复，或者它正在等待你的回答）。",
    TURN_IN_PROGRESS: "上一条回复还在生成中，请先停止或等它结束。",
    SESSION_LOCKED: "这个会话正在另一个客户端上编辑，这里暂时只能看。",

    INVALID_CREDENTIALS: "用户名或密码不正确。",
    ACCOUNT_DISABLED: "这个账号已被禁用，请联系管理员。",
    INVALID_REFRESH_TOKEN: "登录状态已过期，请重新登录。",
    PASSWORD_REQUIRED: "密码不能为空。",
    PASSWORD_TOO_SHORT: "密码至少需要 {min} 个字符。",
    PASSWORD_TOO_LONG: "密码不能超过 {max} 个字符。",
    PASSWORD_UNCHANGED: "新密码不能和当前密码相同。",
    SETUP_REQUIRED: "这个实例还没有管理员。请联系管理员在控制面板中创建账号。",
    PASSWORD_CHANGE_REQUIRED: "请先修改密码，然后才能继续使用。",
    USER_NOT_FOUND: "账号不存在，可能已被删除。",
    USERNAME_TAKEN: "这个用户名已被占用。",
    INVALID_FIELD: "请求里的「{field}」不是合法取值。",
    FORBIDDEN: "当前账号没有执行这个操作的权限。",
    CANNOT_MODIFY_SELF: "不能禁用或降级自己的账号。",
    CANNOT_MODIFY_ADMIN: "只有超级管理员才能管理管理员账号。",
    ROLES_NOT_GRANTABLE: "只有超级管理员才能授予管理员角色。",
    SUPERADMIN_NOT_GRANTABLE:
      "超级管理员只能由桌面控制面板在初始化时创建，不能在网页端新建或授予。",
    PANEL_RESET_REQUIRED: "超级管理员不能在网页端重置自己的密码，请在桌面端控制面板中重置。",
  },

  /**
   * The account's library: every source it holds, whether that arrived as an upload, a page
   * the agent kept, or a file a conversation wrote.
   *
   * `title` is the *only* string behind the name, and it is read by two surfaces — the rail's
   * row and this dialog's heading. It says 资料库 rather than 资料源 because the note-export
   * feature already calls the same place 资料库 (`noteSync.*`), and one destination with two
   * names is the drift this key exists to prevent.
   *
   * `delete.detail` carries the part a user cannot guess: that deleting a conversation did
   * *not* delete this file, and which way round the two actions are. Without it, "delete"
   * reads as tidying up something already gone.
   */
  sources: {
    title: "资料库",
    loading: "读取中…",
    empty: "没有符合条件的资料。",
    parsed: "已解析",
    parsedChars: "已解析 {count} 字",
    parsing: "解析中…",
    parseFailed: "解析失败",
    /** The accessible name of a row's open control. The name is in it because the row's own
     *  label is truncated, so this is also the only place a long filename is readable whole. */
    preview: "预览 {name}",
    search: "搜索",
    searchHint: "按名称查找",
    filterWorkspace: "工作区",
    filterSession: "会话",
    filterCategory: "内容类型",
    filterOrigin: "来源",
    filterMime: "MIME 类型",
    allWorkspaces: "全部工作区",
    allSessions: "全部会话",
    allCategories: "全部类型",
    allOrigins: "全部来源",
    allMimes: "全部 MIME",
    viewFlat: "列表",
    viewTree: "树状",
    expandAll: "展开全部",
    collapseAll: "收起全部",
    add: "添加资料",
    addLinkLabel: "网页地址",
    /* The add dialog: one door, a tab per kind. */
    addKind: "资料类型",
    tabFile: "文件",
    tabLink: "网页链接",
    addDir: "目录",
    addDirHint: "留空表示放到根目录",
    addFiles: "文件",
    pickFiles: "选择文件",
    addLinkHint: "服务端会抓取这个页面并保存下来，稍后可以在会话里引用。",
    viewLabel: "视图",
    /** The four origin values, as the filter and every row's byline spell them. */
    origin: {
      session_attachment: "会话附件",
      workspace_upload: "工作区上传",
      agent_workspace: "助理写入工作区",
      agent_session: "助理写入会话",
      web: "网页",
      note_export: "学习笔记",
      discovered: "已有文件",
    },
    /** The coarse content types. A closed set, so a key per value rather than a pattern. */
    category: {
      page: "网页",
      text: "文本",
      markdown: "Markdown",
      code: "代码",
      diagram: "图表",
      image: "图片",
      document: "文档",
      other: "其他",
    },
    delete: {
      title: "删除文件",
      message: "确定要删除「{name}」吗？",
      detail: "文件本身、已解析的文本，以及在所有对话里的引用都会被删除，无法恢复。这些对话里已发出的消息仍会显示附件，但打不开了。",
      action: "删除文件",
    },
    /**
     * Leaving the app for the page a web source was fetched from. Its own verb rather than a
     * second reading of `preview`: the row opens the app's *stored copy* of the page, and this
     * opens the page itself — which is a different destination and somebody else's website.
     */
    openInBrowser: "在浏览器中打开",
    openExternal: {
      title: "即将打开第三方网址",
      message: "这个链接指向站外，打开后会离开本应用。",
      confirm: "继续打开",
    },
    /**
     * The file preview's copy control, and the caveat it carries on a file past the preview cap.
     *
     * The caveat is not decoration: the server sends the head of the file and says so in the body,
     * and a button reading only 复制 would let somebody take a quarter of a log away believing it
     * was all of it. The two strings sit in different places — the button is in the header, the
     * note is under the text — so this is the one that travels with the control.
     */
    copyFile: "复制文件内容",
    copyFilePartial: "复制文件内容（文件较大，只有已载入的部分）",
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
